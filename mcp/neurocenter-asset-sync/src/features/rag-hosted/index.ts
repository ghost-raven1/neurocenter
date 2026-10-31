import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { api, hub, readState, writeState } from '../../bridge/state.js';
import type { Package } from '../../bridge/package.js';
import { projectFolder } from '../../bridge/workspace.js';
import { readPrivateConfiguration } from '../local-configuration/private-store.js';
import {
    assertHostedInstallation,
    grantIdentity,
    normalizeHostedProfile,
    profileKey,
    requestProfile,
    sameSelection,
    supportsHostedGrants,
    usableHostedGrant,
    validateSelection,
    type HostedProfile,
    type HostedRequestProfile,
    type HostedSelection,
} from './profile.js';
import { createHostedRelay, inferHosted, hostedInstallationIdentity, type HostedRelay } from './relay.js';
export { readHostedRagEmbedding } from './profile.js';
export type { HostedSelection } from './profile.js';
const registry = 'rag-hosted-connections';
const relays = new Map<string, HostedRelay>();
let operations: Promise<void> = Promise.resolve();
async function exclusive<T>(action: () => Promise<T>): Promise<T> {
    const previous = operations;
    let release = () => {};
    operations = new Promise<void>((resolve) => {
        release = resolve;
    });
    await previous;
    try {
        return await action();
    } finally {
        release();
    }
}
async function keys(): Promise<string[]> {
    const value = await readState<unknown>(registry);
    if (value === undefined) return [];
    if (
        !Array.isArray(value) ||
        value.length > 128 ||
        value.some((key) => typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key))
    )
        throw new Error('Повреждён список подключений RAG.');
    return value as string[];
}
async function assertCurrent(profile: HostedRequestProfile): Promise<void> {
    const value = await api<{ revision: number; modelPin: string; profile: HostedSelection['profile'] }>(
        'embedding/context',
        {
            projectId: profile.projectId,
            bindingId: profile.bindingId,
            instanceId: profile.instanceId,
            expectedRevision: profile.selection.revision,
            expectedModelPin: profile.selection.modelPin,
            installation: hostedInstallationIdentity(profile),
        },
    );
    if (!sameSelection(profile.selection, { ...value, model: null }))
        throw new Error('Модель проекта изменилась. Обновите страницу и подключите её повторно.');
}
export interface IHostedReindexResult {
    complete: true;
    rowCount: number;
    snapshotHash: string;
}
export interface IHostedConnectionTransaction {
    key: string;
    before: unknown | null;
    after: unknown;
    embedding: { profile: HostedSelection['profile']; baseUrl: string; apiKey: string };
}
/** Проверка модели предшествует единой транзакции подключения и изолированной переиндексации. */
export async function connectHostedRag(
    projectId: string,
    bindingId: string,
    instanceId: string,
    pkg: Package,
    selection: HostedSelection,
    authorize: () => Promise<void>,
    transaction: (context: IHostedConnectionTransaction) => Promise<IHostedReindexResult>,
): Promise<{
    status: 'connected';
    revision: number;
    modelPin: string;
    profile: HostedSelection['profile'];
    requiresRestart: true;
    reindex: IHostedReindexResult;
}> {
    pkg = structuredClone(pkg);
    selection = structuredClone(selection);
    return exclusive(async () => {
        validateSelection(selection);
        await authorize();
        const root = await projectFolder(projectId);
        const key = profileKey(hub(), root, instanceId);
        const previous = await readPrivateConfiguration<unknown>(key),
            prior = previous === undefined ? undefined : normalizeHostedProfile(previous);
        if (
            prior &&
            (prior.server !== hub() ||
                prior.root !== root ||
                prior.projectId !== projectId ||
                prior.bindingId !== bindingId ||
                prior.instanceId !== instanceId)
        )
            throw new Error('Привязка RAG изменилась. Подключите модель повторно.');
        if (
            !supportsHostedGrants(pkg) ||
            (pkg.config?.extra?.hostedEmbedding as { reindexSchemaVersion?: unknown } | undefined)
                ?.reindexSchemaVersion !== 1
        )
            throw new Error('Обновите этот OpenCodeRAG для управляемой переиндексации.');
        const oldGrant = prior?.grants.find((grant) => grantIdentity(grant.pkg) === grantIdentity(pkg));
        const reuse =
            oldGrant &&
            oldGrant.pkg.manifest.sha256 === pkg.manifest.sha256 &&
            oldGrant.pkg.plugin.version === pkg.plugin.version &&
            sameSelection(oldGrant.selection, selection);
        const grant = { pkg, selection, key: reuse ? oldGrant.key : randomBytes(32).toString('hex') };
        const retained = [];
        for (const item of prior?.grants ?? []) {
            if (grantIdentity(item.pkg) === grantIdentity(pkg)) continue;
            if (!supportsHostedGrants(item.pkg)) {
                let installed = true;
                try {
                    await assertHostedInstallation(requestProfile(prior!, item));
                } catch {
                    installed = false;
                }
                if (installed)
                    throw new Error(
                        'Для совместного подключения обновите MCP и плагин OpenCodeRAG, затем подключите модель повторно.',
                    );
                continue;
            }
            retained.push(item);
        }
        const grants = [...retained, grant];
        if (grants.length > 16) throw new Error('Достигнут лимит явно подключённых пакетов RAG.');
        const candidate: HostedProfile = {
            schemaVersion: 2,
            server: hub(),
            root,
            projectId,
            bindingId,
            instanceId,
            grants,
            relay: prior?.relay ?? { port: 0 },
        };
        const request = () => requestProfile(candidate, grant);
        await assertHostedInstallation(request());
        await assertCurrent(request());
        let created: HostedRelay | undefined;
        const running = relays.get(key);
        if (running && !isDeepStrictEqual(running.profile.relay, candidate.relay))
            throw new Error('Локальное подключение изменилось. Перезапустите мост.');
        let localCommitted = false;
        try {
            if (!running) created = await createHostedRelay(candidate);
            await inferHosted(
                request(),
                ['Neurocenter embedding connection probe 1', 'Neurocenter embedding connection probe 2'],
                AbortSignal.timeout(120000),
            );
            await authorize();
            await assertHostedInstallation(request());
            await assertCurrent(request());
            const entries = await keys();
            if (!entries.includes(key) && entries.length >= 128) throw new Error('Достигнут лимит подключений RAG.');
            if (running)
                running.profile = {
                    ...structuredClone(candidate),
                    grants: [...(prior?.grants ?? []).filter((item) => item.key !== grant.key), grant],
                };
            const reindex = await transaction({
                key,
                before: previous ?? null,
                after: candidate,
                embedding: {
                    profile: selection.profile,
                    baseUrl: `http://127.0.0.1:${candidate.relay.port}/v1`,
                    apiKey: grant.key,
                },
            });
            localCommitted = true;
            if (running) running.profile = structuredClone(candidate);
            else relays.set(key, created!);
            if (!entries.includes(key)) await writeState(registry, [...entries, key]);
            return {
                status: 'connected',
                revision: selection.revision,
                modelPin: selection.modelPin,
                profile: selection.profile,
                requiresRestart: true,
                reindex,
            };
        } catch (error) {
            const committed = localCommitted || !!(error as { localChangesCommitted?: boolean }).localChangesCommitted;
            if (committed) {
                if (running) running.profile = structuredClone(candidate);
                else if (created) relays.set(key, created);
                throw Object.assign(
                    error instanceof Error ? error : new Error('Локальное переключение требует проверки.'),
                    { localChangesCommitted: true },
                );
            }
            if (running && prior) running.profile = structuredClone(prior);
            await created?.close();
            throw error;
        }
    });
}
/** Старый адрес сохраняется: занятый порт не заменяется другим без явного подключения. */
export async function startHostedRagConnections(): Promise<void> {
    await exclusive(async () => {
        for (const key of await keys()) {
            if (relays.has(key)) continue;
            try {
                const raw = await readPrivateConfiguration<unknown>(key);
                if (!raw) continue;
                const profile = normalizeHostedProfile(raw);
                if (profileKey(profile.server, profile.root, profile.instanceId) !== key) continue;
                await usableHostedGrant(profile);
                relays.set(key, await createHostedRelay(profile));
            } catch {
                /* Недоступная или отозванная привязка не блокирует запуск остальных проектов. */
            }
        }
    });
}
/** Закрывает только собственные loopback-серверы и прерывает их текущие запросы. */
export async function stopHostedRagConnections(): Promise<void> {
    await exclusive(async () => {
        const active = [...relays.values()];
        relays.clear();
        await Promise.all(active.map((relay) => relay.close()));
    });
}
