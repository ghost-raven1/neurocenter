import fs from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { hash, hub } from '../../bridge/state.js';
import { verify, type Package } from '../../bridge/package.js';
import { projectFolder, projectBindingId, projectInstanceId } from '../../bridge/workspace.js';
import { inspectInstallation } from '../../bridge/installation-inspection.js';
import { readPrivateConfiguration } from '../local-configuration/private-store.js';
export interface HostedSelection {
    revision: number;
    modelPin: string;
    profile: { provider: 'openai'; model: string; dimension: number };
    model: unknown;
}
interface HostedWorkspace {
    server: string;
    root: string;
    projectId: string;
    bindingId: string;
    instanceId: string;
}
export interface HostedGrant {
    pkg: Package;
    selection: HostedSelection;
    key: string;
}
export interface HostedProfile extends HostedWorkspace {
    schemaVersion: 2;
    relay: { port: number };
    grants: HostedGrant[];
}
/** Отдельный grant остаётся совместимым с уже запущенным legacy-клиентом. */
export interface HostedRequestProfile extends HostedWorkspace {
    pkg: Package;
    selection: HostedSelection;
    relay: { port: number; key: string };
}
const invalid = () => new Error('Приватное подключение RAG повреждено. Подключите модель повторно.');
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> =>
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
export const grantIdentity = (pkg: Package): string => pkg.plugin.kind + ':' + pkg.plugin.id;
export const supportsHostedGrants = (pkg: Package): boolean =>
    (pkg.config?.extra?.hostedEmbedding as { profileSchemaVersion?: unknown } | undefined)?.profileSchemaVersion === 2;
/** Legacy читается без записи; миграция выполняется только явным подключением с CAS. */
export function normalizeHostedProfile(value: unknown): HostedProfile {
    const raw = value as HostedWorkspace & {
        schemaVersion: number;
        grants: HostedGrant[];
        pkg: Package;
        selection: HostedSelection;
        relay: { port: number; key: string };
    };
    if (
        !raw ||
        ![1, 2].includes(raw.schemaVersion) ||
        !['server', 'root', 'projectId', 'bindingId', 'instanceId'].every(
            (key) =>
                typeof raw[key as keyof HostedWorkspace] === 'string' &&
                raw[key as keyof HostedWorkspace].length > 0 &&
                raw[key as keyof HostedWorkspace].length <= 32768,
        ) ||
        !exact(raw, [
            'schemaVersion',
            'server',
            'root',
            'projectId',
            'bindingId',
            'instanceId',
            'relay',
            ...(raw.schemaVersion === 1 ? ['pkg', 'selection'] : ['grants']),
        ]) ||
        !exact(raw.relay, raw.schemaVersion === 1 ? ['port', 'key'] : ['port']) ||
        !Number.isInteger(raw.relay.port) ||
        raw.relay.port < 1 ||
        raw.relay.port > 65535
    )
        throw invalid();
    const grants =
        raw.schemaVersion === 1 ? [{ pkg: raw.pkg, selection: raw.selection, key: raw.relay.key }] : raw.grants;
    if (!Array.isArray(grants) || !grants.length || grants.length > 16) throw invalid();
    const identities = new Set<string>(),
        keys = new Set<string>();
    for (const grant of grants) {
        if (
            !exact(grant, ['pkg', 'selection', 'key']) ||
            typeof grant.key !== 'string' ||
            !/^[a-f0-9]{64}$/.test(grant.key)
        )
            throw invalid();
        try {
            verify(grant.pkg);
            validateSelection(grant.selection);
        } catch {
            throw invalid();
        }
        if (
            !['mcp', 'plugin'].includes(grant.pkg.plugin.kind) ||
            (grant.pkg.config?.extra?.hostedEmbedding as { schemaVersion?: unknown } | undefined)?.schemaVersion !==
                1 ||
            (raw.schemaVersion === 2 && !supportsHostedGrants(grant.pkg)) ||
            identities.has(grantIdentity(grant.pkg)) ||
            keys.has(grant.key)
        )
            throw invalid();
        identities.add(grantIdentity(grant.pkg));
        keys.add(grant.key);
    }
    return structuredClone({
        schemaVersion: 2,
        server: raw.server,
        root: raw.root,
        projectId: raw.projectId,
        bindingId: raw.bindingId,
        instanceId: raw.instanceId,
        relay: { port: raw.relay.port },
        grants,
    });
}
export function requestProfile(profile: HostedProfile, grant: HostedGrant): HostedRequestProfile {
    return {
        server: profile.server,
        root: profile.root,
        projectId: profile.projectId,
        bindingId: profile.bindingId,
        instanceId: profile.instanceId,
        pkg: grant.pkg,
        selection: grant.selection,
        relay: { port: profile.relay.port, key: grant.key },
    };
}
export const profileKey = (server: string, root: string, instanceId: string): string =>
    hash(JSON.stringify([server, root, instanceId]));
export function validateSelection(value: HostedSelection): void {
    if (
        !value ||
        !Number.isSafeInteger(value.revision) ||
        value.revision < 1 ||
        !/^[a-f0-9]{64}$/.test(value.modelPin) ||
        !exact(value.profile, ['provider', 'model', 'dimension']) ||
        value.profile.provider !== 'openai' ||
        !Number.isSafeInteger(value.profile.dimension) ||
        value.profile.dimension < 1 ||
        value.profile.dimension > 65535 ||
        !/^neurocenter\/[A-Za-z0-9._-]+\/sha256\/[a-f0-9]{64}$/.test(value.profile.model) ||
        !value.profile.model.endsWith('/' + value.modelPin)
    )
        throw new Error('Выбранная серверная модель не подтверждена. Обновите настройку проекта.');
}
/** Удаление, смена версии и перенос папки немедленно закрывают доступ к relay. */
export async function assertHostedInstallation(profile: HostedRequestProfile): Promise<void> {
    validateSelection(profile.selection);
    verify(profile.pkg);
    if (
        profile.server !== hub() ||
        !['mcp', 'plugin'].includes(profile.pkg.plugin.kind) ||
        (profile.pkg.config?.extra?.hostedEmbedding as { schemaVersion?: unknown } | undefined)?.schemaVersion !== 1 ||
        (await projectFolder(profile.projectId)) !== profile.root ||
        (await projectBindingId(profile.projectId)) !== profile.bindingId ||
        (await projectInstanceId(profile.projectId)) !== profile.instanceId
    )
        throw new Error('Привязка или версия OpenCodeRAG изменилась. Подключите модель повторно.');
    const inspection = await inspectInstallation(profile.projectId, profile.pkg);
    if (inspection.state !== 'checked' || inspection.status !== 'synced')
        throw new Error('Сначала проверьте или восстановите установленный OpenCodeRAG.');
}
async function usableGrants(profile: HostedProfile, pkg?: Package): Promise<HostedGrant[]> {
    const usable: HostedGrant[] = [];
    for (const grant of [...profile.grants].reverse()) {
        if (
            pkg &&
            (grantIdentity(grant.pkg) !== grantIdentity(pkg) ||
                grant.pkg.plugin.version !== pkg.plugin.version ||
                grant.pkg.manifest.sha256 !== pkg.manifest.sha256)
        )
            continue;
        try {
            await assertHostedInstallation(requestProfile(profile, grant));
            usable.push(grant);
        } catch {
            /* Проверяем следующий явно выданный grant. */
        }
    }
    if (!usable.length)
        throw new Error('Сначала проверьте установленный OpenCodeRAG и подключите к нему модель повторно.');
    return usable;
}
/** Отозванный сосед не блокирует действующий grant и не даёт ему заимствовать ключ. */
export async function usableHostedGrant(profile: HostedProfile): Promise<HostedGrant> {
    return (await usableGrants(profile))[0]!;
}
export function sameSelection(a: HostedSelection, b: HostedSelection): boolean {
    return a.revision === b.revision && a.modelPin === b.modelPin && isDeepStrictEqual(a.profile, b.profile);
}
/** Публичное представление содержит только identity индекса, без локального или серверного секрета. */
export async function readHostedRagEmbedding(
    root: string,
    projectId?: string,
    pkg?: Package,
): Promise<{ provider: 'openai'; model: string; baseUrl: string; vectorDimension: number } | undefined> {
    const real = await fs.realpath(root);
    let marker: { projectId?: string; instanceId?: string; server?: string };
    try {
        marker = JSON.parse(await fs.readFile(real + '/.opencode/neurocenter.json', 'utf8'));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
    }
    if (!marker.instanceId || marker.server !== hub() || (projectId && marker.projectId !== projectId))
        return undefined;
    const raw = await readPrivateConfiguration<unknown>(profileKey(hub(), real, marker.instanceId));
    if (raw === undefined) return undefined;
    const value = normalizeHostedProfile(raw),
        grants = await usableGrants(value, pkg),
        grant = grants[0]!;
    if (!pkg && grants.some((item) => !isDeepStrictEqual(item.selection.profile, grant.selection.profile)))
        throw new Error(
            'Для общего индекса выберите одну модель и подключите её повторно к MCP и плагину OpenCodeRAG.',
        );
    return {
        provider: 'openai',
        model: grant.selection.profile.model,
        baseUrl: `http://127.0.0.1:${value.relay.port}/v1`,
        vectorDimension: grant.selection.profile.dimension,
    };
}
