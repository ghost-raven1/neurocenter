export { CODEX_AUTH_MARKER, CODEX_PROVIDER_ID } from '../constants.js';
import { CodexConnection } from '../connection/connection.js';
import { z } from 'zod';
import { statusSchema, modelSchema } from './constants.js';
import type { ICodexSession, ICodexModel } from './interfaces.js';

/** Read access credentials through Codex's official RPC; never read or copy its credential store. */
export async function loadSession(
    refreshToken: boolean,
    options?: { env?: NodeJS.ProcessEnv },
): Promise<ICodexSession> {
    const connection = new CodexConnection(undefined, [], options?.env);
    try {
        await connection.initialize();
        const status = statusSchema.parse(await connection.call('getAuthStatus', { includeToken: true, refreshToken }));
        if (status.authMethod !== 'chatgpt' || !status.authToken) throw new Error('ChatGPT login required');
        const claims = JSON.parse(Buffer.from(status.authToken.split('.')[1] ?? '', 'base64url').toString());
        const accountId = claims['https://api.openai.com/auth']?.chatgpt_account_id;
        if (typeof accountId !== 'string' || !accountId || typeof claims.exp !== 'number')
            throw new Error('Incomplete credentials');
        return { accessToken: status.authToken, accountId, expiresAt: claims.exp * 1000 };
    } catch {
        throw new Error(
            'Codex ChatGPT authentication is unavailable. Open the provider settings in Neurocenter to sign in.',
        );
    } finally {
        await connection.close();
    }
}

/** Serialize token refresh within this plugin and keep a short expiry margin. */
export function createSessionReader(load: (refresh: boolean) => Promise<ICodexSession> = loadSession) {
    let session: ICodexSession | undefined;
    let checkedAt = 0;
    let pending: Promise<ICodexSession> | undefined;
    let pendingRefresh = false;
    return async function read(forceRefresh = false): Promise<ICodexSession> {
        if (pending) {
            if (!forceRefresh || pendingRefresh) return pending;
            // A rejected HTTP token must not be retried after merely re-reading the same token.
            await pending.catch(() => undefined);
            return read(true);
        }
        if (!forceRefresh && session && session.expiresAt > Date.now() + 60_000 && Date.now() - checkedAt < 60_000)
            return session;
        pendingRefresh = forceRefresh || Boolean(session && session.expiresAt <= Date.now() + 60_000);
        pending = (async () => {
            let next = await load(pendingRefresh);
            if (next.expiresAt <= Date.now() + 60_000) {
                pendingRefresh = true;
                next = await load(true);
            }
            if (next.expiresAt <= Date.now())
                throw new Error('Codex returned expired access credentials; open the provider settings in Neurocenter');
            session = next;
            checkedAt = Date.now();
            return next;
        })();
        try {
            return await pending;
        } finally {
            pending = undefined;
            pendingRefresh = false;
        }
    };
}

let sharedSessionReader = createSessionReader();

export const readCodexSession = (refresh = false) => sharedSessionReader(refresh);

/** Forget the previous account immediately after an explicit successful login. */
export function invalidateCodexSession(): void {
    sharedSessionReader = createSessionReader();
}

/** Return only non-secret model metadata from the same Codex account as the bridge. */
export async function connectCodex(): Promise<{ models: ICodexModel[]; defaultModel: string }> {
    await readCodexSession();
    const connection = new CodexConnection();
    try {
        await connection.initialize();
        const models: ICodexModel[] = [];
        let cursor: string | null = null;
        const seen = new Set<string>();
        let pages = 0;
        do {
            if (++pages > 20 || (cursor && seen.has(cursor))) throw new Error('Codex model pagination did not finish');
            if (cursor) seen.add(cursor);
            const page = z
                .object({ data: z.array(modelSchema), nextCursor: z.string().nullable() })
                .parse(await connection.call('model/list', { limit: 100, cursor, includeHidden: false }));
            for (const model of page.data.filter((model) => !model.hidden))
                models.push({
                    id: model.model,
                    name: model.displayName,
                    isDefault: model.isDefault,
                    inputModalities: model.inputModalities,
                    defaultReasoningEffort: model.defaultReasoningEffort,
                    reasoningEfforts: model.supportedReasoningEfforts.map((option) => option.reasoningEffort),
                });
            cursor = page.nextCursor;
        } while (cursor);
        if (!models.length) throw new Error('Codex returned no visible models');
        const configuration = z
            .object({ config: z.object({ model: z.string().nullable().optional() }).passthrough() })
            .parse(await connection.call('config/read', { includeLayers: false }));
        const configured = models.find((model) => model.id === configuration.config.model);
        return { models, defaultModel: (configured ?? models.find((model) => model.isDefault) ?? models[0]!).id };
    } finally {
        await connection.close();
    }
}
