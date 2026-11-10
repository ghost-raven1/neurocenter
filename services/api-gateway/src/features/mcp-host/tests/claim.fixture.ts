import type { IMcpHostLimits } from '../host';
import type { IHostedMcpClaim } from '../ticket';

/**
 * S3.a (2.13): общий claim-fixture mcp-host — три почти идентичные фабрики
 * (ticket-ttl, host-pool, host-auth-cache) сведены сюда; файлы различаются только
 * overrides (name, сессия, operationRemote, authzCacheTtlMs).
 * Имя не *.test.ts: файл не участвует в наборе vitest-тестов.
 */
export interface IClaimFixtureOverrides {
    name?: string;
    deviceId?: string;
    projectId?: string;
    assetId?: string;
    artifactSha256?: string;
    operationRemote?: { url: string; headers: Record<string, string> };
}

export const makeClaim = (over: IClaimFixtureOverrides = {}): IHostedMcpClaim => ({
    artifactSha256: over.artifactSha256 ?? 'a'.repeat(64),
    descriptorSha256: 'e'.repeat(64),
    entrypoint: 'server.mjs',
    executable: false,
    name: over.name ?? 'host',
    compressedBytes: 12,
    session: {
        deviceId: over.deviceId ?? 'device-1',
        projectId: over.projectId ?? 'project-1',
        assetId: over.assetId ?? 'asset-1',
        version: 1,
        manifest: 'b'.repeat(64),
    },
    ...(over.operationRemote !== undefined ? { operationRemote: over.operationRemote } : {}),
});

/** Квоты хостов MCP: дефолты AD-4; различие в файлах — только authzCacheTtlMs. */
export const makeLimits = (over: Partial<IMcpHostLimits> = {}): IMcpHostLimits => ({
    maxHosts: 4,
    maxPerProject: 8,
    maxPerDevice: 2,
    maxChannelsPerHost: 4,
    authzCacheTtlMs: 60000,
    ...over,
});
