import type { NextFunction } from 'express';
import { z } from 'zod';
import { asyncWrapper } from '../../utils/asyncWrapper.js';
import { zodErrorToHTTP, stringifyError, metrics } from '@nangohq/utils';
import {
    analytics,
    configService,
    AnalyticsTypes,
    getConnectionConfig,
    connectionService,
    errorManager,
    ErrorSourceEnum,
    LogActionEnum,
    getProvider,
    linkConnection
} from '@nangohq/shared';
import type { PostPublicTableauAuthorization } from '@nangohq/types';
import type { LogContext } from '@nangohq/logs';
import { defaultOperationExpiration, endUserToMeta, logContextGetter } from '@nangohq/logs';
import { hmacCheck } from '../../utils/hmac.js';
import { connectionCreated as connectionCreatedHook, connectionCreationFailed as connectionCreationFailedHook } from '../../hooks/hooks.js';
import { connectionCredential, connectionIdSchema, providerConfigKeySchema } from '../../helpers/validation.js';
import db from '@nangohq/database';
import { errorRestrictConnectionId, isIntegrationAllowed } from '../../utils/auth.js';

const bodyValidation = z
    .object({
        pat_name: z.string().min(1),
        pat_secret: z.string().min(1),
        content_url: z.string().optional()
    })
    .strict();

const queryStringValidation = z
    .object({
        connection_id: connectionIdSchema.optional(),
        params: z.record(z.any()).optional(),
        user_scope: z.string().optional()
    })
    .and(connectionCredential);

const paramValidation = z
    .object({
        providerConfigKey: providerConfigKeySchema
    })
    .strict();

export const postPublicTableauAuthorization = asyncWrapper<PostPublicTableauAuthorization>(async (req, res, next: NextFunction) => {
    const val = bodyValidation.safeParse(req.body);
    if (!val.success) {
        res.status(400).send({
            error: { code: 'invalid_body', errors: zodErrorToHTTP(val.error) }
        });
        return;
    }

    const queryStringVal = queryStringValidation.safeParse(req.query);
    if (!queryStringVal.success) {
        res.status(400).send({
            error: { code: 'invalid_query_params', errors: zodErrorToHTTP(queryStringVal.error) }
        });
        return;
    }

    const paramVal = paramValidation.safeParse(req.params);
    if (!paramVal.success) {
        res.status(400).send({
            error: { code: 'invalid_uri_params', errors: zodErrorToHTTP(paramVal.error) }
        });
        return;
    }

    const { account, environment, connectSession } = res.locals;
    const { pat_name: patName, pat_secret: patSecret, content_url: contentUrl }: PostPublicTableauAuthorization['Body'] = val.data;
    const queryString: PostPublicTableauAuthorization['Querystring'] = queryStringVal.data;
    const { providerConfigKey }: PostPublicTableauAuthorization['Params'] = paramVal.data;
    const connectionConfig = queryString.params ? getConnectionConfig(queryString.params) : {};
    let connectionId = queryString.connection_id || connectionService.generateConnectionId();
    const hmac = 'hmac' in queryString ? queryString.hmac : undefined;
    const isConnectSession = res.locals['authType'] === 'connectSession';

    if (isConnectSession && queryString.connection_id) {
        errorRestrictConnectionId(res);
        return;
    }

    let logCtx: LogContext | undefined;

    try {
        const logCtx =
            isConnectSession && connectSession.operationId
                ? await logContextGetter.get({ id: connectSession.operationId, accountId: account.id })
                : await logContextGetter.create(
                      {
                          operation: { type: 'auth', action: 'create_connection' },
                          meta: { authType: 'tableau', connectSession: endUserToMeta(res.locals.endUser) },
                          expiresAt: defaultOperationExpiration.auth()
                      },
                      { account, environment }
                  );
        void analytics.track(AnalyticsTypes.PRE_TBA_AUTH, account.id);

        if (!isConnectSession) {
            const checked = await hmacCheck({ environment, logCtx, providerConfigKey, connectionId, hmac, res });
            if (!checked) {
                return;
            }
        }

        const config = await configService.getProviderConfig(providerConfigKey, environment.id);
        if (!config) {
            void logCtx.error('Unknown provider config');
            await logCtx.failed();
            res.status(404).send({ error: { code: 'unknown_provider_config' } });
            return;
        }

        const provider = getProvider(config.provider);
        if (!provider) {
            void logCtx.error('Unknown provider');
            await logCtx.failed();
            res.status(404).send({ error: { code: 'unknown_provider_template' } });
            return;
        }

        if (provider.auth_mode !== 'TABLEAU') {
            void logCtx.error('Provider does not support Tableau auth', { provider: config.provider });
            await logCtx.failed();
            res.status(400).send({ error: { code: 'invalid_auth_mode' } });
            return;
        }

        if (!(await isIntegrationAllowed({ config, res, logCtx }))) {
            return;
        }

        // Reconnect mechanism
        if (isConnectSession && connectSession.connectionId) {
            const connection = await connectionService.getConnectionById(connectSession.connectionId);
            if (!connection) {
                void logCtx.error('Invalid connection');
                await logCtx.failed();
                res.status(400).send({ error: { code: 'invalid_connection' } });
                return;
            }
            connectionId = connection?.connection_id;
        }

        await logCtx.enrichOperation({ integrationId: config.id!, integrationName: config.unique_key, providerName: config.provider });

        const {
            success,
            error,
            response: credentials
        } = await connectionService.getTableauCredentials(provider, patName, patSecret, connectionConfig, contentUrl);

        if (!success || !credentials) {
            void logCtx.error('Error during Tableau credentials creation', { error, provider: config.provider });
            await logCtx.failed();

            errorManager.errRes(res, 'tableau_error');

            return;
        }

        const [updatedConnection] = await connectionService.upsertAuthConnection({
            connectionId,
            providerConfigKey,
            credentials,
            connectionConfig,
            metadata: {},
            config,
            environment,
            account
        });
        if (!updatedConnection) {
            res.status(500).send({ error: { code: 'server_error', message: 'failed to create connection' } });
            void logCtx.error('Failed to create connection');
            await logCtx.failed();
            return;
        }

        if (isConnectSession) {
            await linkConnection(db.knex, { endUserId: connectSession.endUserId, connection: updatedConnection.connection });
        }

        await logCtx.enrichOperation({ connectionId: updatedConnection.connection.id, connectionName: updatedConnection.connection.connection_id });
        void logCtx.info('Tableau credentials creation was successful');
        await logCtx.success();

        void connectionCreatedHook(
            {
                connection: updatedConnection.connection,
                environment,
                account,
                auth_mode: 'TABLEAU',
                operation: updatedConnection.operation,
                endUser: isConnectSession ? res.locals['endUser'] : undefined
            },
            account,
            config,
            logContextGetter
        );

        metrics.increment(metrics.Types.AUTH_SUCCESS, 1, { auth_mode: provider.auth_mode });

        res.status(200).send({ providerConfigKey, connectionId });
    } catch (err) {
        const prettyError = stringifyError(err, { pretty: true });

        void connectionCreationFailedHook(
            {
                connection: { connection_id: connectionId, provider_config_key: providerConfigKey },
                environment,
                account,
                auth_mode: 'TABLEAU',
                error: {
                    type: 'unknown',
                    description: `Error during Unauth create: ${prettyError}`
                },
                operation: 'unknown'
            },
            account
        );
        if (logCtx) {
            void logCtx.error('Error during Tableau credentials creation', { error: err });
            await logCtx.failed();
        }

        errorManager.report(err, {
            source: ErrorSourceEnum.PLATFORM,
            operation: LogActionEnum.AUTH,
            environmentId: environment.id,
            metadata: { providerConfigKey, connectionId }
        });

        metrics.increment(metrics.Types.AUTH_FAILURE, 1, { auth_mode: 'TABLEAU' });

        next(err);
    }
});
