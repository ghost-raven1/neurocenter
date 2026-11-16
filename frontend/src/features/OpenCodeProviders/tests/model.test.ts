import { describe, expect, it } from 'vitest';
import { globalProviderFallback, globalProviderInventory } from '../model';
import type { IBridgeJob } from '../../McpBridge/api';
import type { IGlobalProvider, IOpenCodeGlobalProvidersInventory } from '@neurocenter/opencode-local-providers';

const DEVICE = '12345678-1234-4234-8234-123456789012';
const JOB = '22345678-1234-4234-8234-123456789012';
const READ = 'inspect-opencode-global-providers';
const inventory = (providers: IGlobalProvider[]): IOpenCodeGlobalProvidersInventory => ({
    providers,
    configurationFound: !!providers.length,
    authenticationFound: false,
    overrideDetected: false,
    issues: [],
});
const provider = (patch: Partial<IGlobalProvider> = {}): IGlobalProvider => ({
    id: 'openai',
    modelIds: ['gpt-5'],
    hasConfiguration: true,
    hasAuthentication: true,
    authentication: 'api',
    enabled: true,
    ...patch,
});
const readResult = (jobId: string, inv: IOpenCodeGlobalProvidersInventory) => ({
    schemaVersion: 1,
    scope: 'global',
    deviceId: DEVICE,
    jobId,
    kind: READ,
    checkedAt: '2026-11-16T00:00:00.000Z',
    status: 'checked',
    inventory: inv,
});
const readJob = (patch: Partial<IBridgeJob>, result?: Record<string, unknown>): IBridgeJob => ({
    id: JOB,
    deviceId: DEVICE,
    projectId: null,
    kind: READ,
    state: 'succeeded',
    message: '',
    createdAt: '2026-11-16T00:00:00.000Z',
    updatedAt: '2026-11-16T00:00:00.000Z',
    ...patch,
    ...(result !== undefined ? { result } : {}),
});

describe('globalProviderInventory', () => {
    it('возвращает подтверждённую инвентаризацию последующего чтения', () => {
        const jobs = [readJob({}, readResult(JOB, inventory([provider()])) as Record<string, unknown>)];
        expect(globalProviderInventory(jobs, DEVICE)?.providers[0]?.id).toBe('openai');
    });
    it('игнорирует чужие компьютеры, другие задания и незавершённое состояние', () => {
        const result = readResult(JOB, inventory([provider()]));
        const jobs = [
            readJob({ deviceId: '11111111-1111-4111-8111-111111111111' }, result),
            readJob({ kind: 'open-opencode-global-providers' }, result),
            readJob({ state: 'running' }, result),
        ];
        expect(globalProviderInventory(jobs, DEVICE)).toBeUndefined();
    });
    it('берёт последнее подтверждённое чтение по updatedAt', () => {
        const oldJob = readJob(
            { id: '32345678-1234-4234-8234-123456789012' },
            readResult('32345678-1234-4234-8234-123456789012', inventory([provider({ id: 'openai' })])),
        );
        const newJob = readJob(
            { updatedAt: '2026-11-16T01:00:00.000Z' },
            readResult(JOB, inventory([provider({ id: 'ollama' })])),
        );
        expect(globalProviderInventory([newJob, oldJob], DEVICE)?.providers[0]?.id).toBe('ollama');
    });
    it('недоверенное или упавшее чтение не становится инвентаризацией', () => {
        const tampered = { ...readResult(JOB, inventory([provider()])), jobId: '99999999-1234-4234-8234-123456789012' };
        expect(globalProviderInventory([readJob({}, tampered)], DEVICE)).toBeUndefined();
        const failed = {
            schemaVersion: 1,
            scope: 'global',
            deviceId: DEVICE,
            jobId: JOB,
            kind: READ,
            checkedAt: '2026-11-16T00:00:00.000Z',
            status: 'failed',
            issue: 'read-failed',
        };
        expect(globalProviderInventory([readJob({}, failed)], DEVICE)).toBeUndefined();
    });
});

describe('globalProviderFallback', () => {
    const inv = inventory([
        provider({ id: 'disabled', enabled: false }),
        provider({ id: 'no-config', hasConfiguration: false }),
        provider({ id: 'global-openai' }),
    ]);
    it('срабатывает только на отсутствующей проектной конфигурации', () => {
        expect(globalProviderFallback({ state: 'missing' }, inv)?.id).toBe('global-openai');
        expect(globalProviderFallback({ state: 'configured' }, inv)).toBeUndefined();
        expect(globalProviderFallback(undefined, inv)).toBeUndefined();
        expect(globalProviderFallback({ state: 'missing' }, undefined)).toBeUndefined();
    });
    it('переходит к первому включённому провайдеру с конфигурацией', () => {
        expect(globalProviderFallback({ state: 'missing' }, inv)?.id).toBe('global-openai');
        expect(globalProviderFallback({ state: 'missing' }, inventory([]))).toBeUndefined();
    });
});
