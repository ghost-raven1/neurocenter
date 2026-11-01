import path from 'node:path';
import os from 'node:os';
import { apiHub, hub, readState, stateDir, type ICredentials } from '../../bridge/state.js';
import { isDeepStrictEqual } from 'node:util';
import { assertOpenCodeAuthOwner } from '../computer-setup/auth-owner.js';
import { openVerificationPage } from '../../bridge/open-browser.js';
import { startGlobalProvidersSession } from '../opencode-local-providers/server.js';
import { contract as global } from '../opencode-local-providers/contract.js';
import { contract } from './contract.js';
import { PersonalKeyEditor } from './editor.js';
import { personalKeyPage } from './page.js';
import { personalKeyWire } from './transport.js';

/** Private window binds the current device/site/API origins and never returns a secret or local URL. */
export async function openPersonalKeySession(jobId: string, raw: unknown) {
    const payload = contract.normalizeOpenCodePersonalKeyPayload(raw),
        site = hub(),
        origin = apiHub(),
        credentials = await readState<ICredentials>('credentials');
    if (!credentials || credentials.deviceId !== payload.deviceId) throw Error('Компьютер изменился.');
    const current = async () => {
        if (
            hub() !== site ||
            apiHub() !== origin ||
            !isDeepStrictEqual(await readState<ICredentials>('credentials'), credentials)
        )
            throw Error('Авторизация компьютера изменилась.');
    };
    const wire = async (route: 'context' | 'save' | 'receipt', input: unknown, signal?: AbortSignal) => {
        await current();
        const value = await personalKeyWire(origin, credentials.token, route, input, signal);
        await current();
        return value;
    };
    const context = contract.normalizeOpenCodePersonalKeyContext(await wire('context', { jobId })),
        recipient = context.recipient;
    if (
        context.expiresAt !== payload.expiresAt ||
        context.requestKey !== payload.requestKey ||
        recipient.ownerEmail !== credentials.email ||
        recipient.modelId !== payload.modelId ||
        recipient.providerId !== payload.providerId ||
        recipient.connectionRevision !== payload.expectedConnectionRevision ||
        recipient.credentialRevision !== payload.expectedCredentialRevision ||
        !recipient.canStoreKey
    )
        throw Error('Получатель изменился.');
    const permit = async (signal?: AbortSignal) => {
        const raw = (await wire('receipt', { jobId }, signal)) as { receipt?: unknown };
        if (!raw || typeof raw !== 'object' || Object.keys(raw).length !== 1 || !('receipt' in raw))
            throw Error('Права не подтверждены.');
        if (raw.receipt !== null) contract.normalizeOpenCodePersonalKeyReceipt(raw.receipt);
    };
    const compatible = (signal?: AbortSignal) =>
        assertOpenCodeAuthOwner(payload.deviceId, permit, signal, contract.OPENCODE_PERSONAL_KEY_VERSION);
    await (await compatible()).assertCurrent();
    return startGlobalProvidersSession({
        id: jobId,
        home: os.homedir(),
        environment: { ...process.env },
        expiresAt: payload.expiresAt,
        limits: global.globalProvidersLimits(process.env),
        authorize: permit,
        assertCurrent: current,
        assertCompatibleCli: compatible,
        open: openVerificationPage,
        privateEditor: {
            page: personalKeyPage,
            create: (session) =>
                new PersonalKeyEditor({
                    ...session,
                    jobId,
                    payload,
                    context,
                    home: os.homedir(),
                    environment: { ...process.env },
                    journalDirectory: path.join(stateDir(), 'opencode-personal-key'),
                    siteOrigin: site,
                    apiOrigin: origin,
                    ownerEmail: credentials.email,
                    wire: (route, input) => wire(route, input, session.signal),
                }),
        },
    });
}
