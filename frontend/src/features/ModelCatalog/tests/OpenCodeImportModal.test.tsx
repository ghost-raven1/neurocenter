// @vitest-environment jsdom
import { stubModalBrowser } from './browser.fixture';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OpenCodeImportModal } from '../OpenCodeImportModal';
import { FeatureAvailabilityContext } from '../../FeatureFlags/FeatureAvailability';
import { featureDefinitions } from '../../FeatureFlags/constants';
import type { IEvaluatedFeatureFlags } from '../../FeatureFlags/interfaces';
const io = vi.hoisted(() => ({
    create: vi.fn(),
    post: vi.fn(),
    reload: vi.fn(),
    deviceId: '11111111-1111-4111-8111-111111111111',
}));
vi.mock('../../McpBridge/api', () => ({ bridgeApi: { create: io.create } }));
vi.mock('../../../core/api/base', () => ({ default: { post: io.post } }));
vi.mock('../../McpBridge/hooks/useBridge', () => ({
    useBridge: () => ({
        devicesReady: true,
        errors: {},
        jobs: [],
        reload: io.reload,
        devices: [
            {
                id: io.deviceId,
                name: 'Work computer',
                online: true,
                report: {
                    capabilities: ['opencode-model-scan-v2'],
                    bindings: [{ projectId: 'project', bindingId: 'binding', instanceId: 'instance' }],
                },
            },
        ],
    }),
}));
vi.mock('../../UserBlock/hooks/useAuthRequestOwner', () => {
    const captureOwner = () => () => true;
    return { useAuthRequestOwner: () => ({ scope: 'owner', captureOwner }) };
});
const candidates = ['first', 'second'].map((name) => ({
    candidateId: name,
    provider: `provider-${name}`,
    name,
    model: `model-${name}`,
    capability: 'chat',
    runtime: 'remote-openai',
    baseUrl: `https://${name}.example.test/v1`,
    hasKey: false,
    blocker: null,
}));
const imported = vi.fn();
let root: Root;
let container: HTMLDivElement;
function result(scope: 'global' | 'project' = 'global') {
    return {
        id: 'job',
        deviceId: io.deviceId,
        state: 'succeeded',
        result: {
            schemaVersion: 2,
            scope,
            deviceId: io.deviceId,
            projectId: 'project',
            bindingId: 'binding',
            instanceId: 'instance',
            candidates,
            warnings: [],
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
    };
}
beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    stubModalBrowser();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('22222222-2222-4222-8222-222222222222');
    io.create.mockResolvedValue(result());
    io.post.mockResolvedValue({
        data: {
            model: { id: 'selected', runtime: 'remote-openai' },
            baseUrl: candidates[1].baseUrl,
            hasKeyOnComputer: false,
        },
    });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});
afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});
async function render(projectId?: string): Promise<void> {
    const flags = Object.fromEntries(
        featureDefinitions.map(({ key }) => [key, true]),
    ) as IEvaluatedFeatureFlags['flags'];
    const data: IEvaluatedFeatureFlags = {
        flags,
        configured: flags,
        blockedBy: Object.fromEntries(
            featureDefinitions.map(({ key }) => [key, [] as IEvaluatedFeatureFlags['blockedBy'][typeof key]]),
        ) as IEvaluatedFeatureFlags['blockedBy'],
    };
    await act(async () =>
        root.render(
            <FeatureAvailabilityContext.Provider
                value={{ data, loading: false, error: null, refresh: async () => undefined }}
            >
                <OpenCodeImportModal projectId={projectId} onClose={vi.fn()} onImported={imported} />
            </FeatureAvailabilityContext.Provider>,
        ),
    );
}
function buttons(label: string): HTMLButtonElement[] {
    return [...document.querySelectorAll('button')].filter((button) => button.textContent?.trim() === label);
}
async function read(): Promise<void> {
    await act(async () => buttons('Прочитать OpenCode')[0].click());
}
it.each(['global', 'project'] as const)(
    'previews the selected %s snapshot before importing only the chosen provider',
    async (scope) => {
        io.create.mockResolvedValue(result(scope));
        await render(scope === 'project' ? 'project' : undefined);
        expect(io.create).not.toHaveBeenCalled();
        expect(io.post).not.toHaveBeenCalled();
        await read();
        expect(io.create).toHaveBeenCalledWith(
            expect.objectContaining({
                scope,
                deviceId: io.deviceId,
                ...(scope === 'project' ? { projectId: 'project', expectedBindingId: 'binding' } : {}),
            }),
        );
        expect(document.body.textContent).toContain(candidates[1].baseUrl);
        expect(document.body.textContent).toContain('provider-second');
        expect(io.post).not.toHaveBeenCalled();
        await act(async () => buttons('Импортировать')[1].click());
        expect(io.post).toHaveBeenCalledWith('/api/models/import-opencode', {
            deviceId: io.deviceId,
            jobId: 'job',
            candidateId: 'second',
        });
        expect(imported).toHaveBeenCalledOnce();
    },
);
it('keeps a failed scan readable and never imports or changes the caller draft', async () => {
    io.create.mockRejectedValueOnce(new Error('Computer unavailable'));
    await render();
    await read();
    expect(document.body.textContent).toContain('Computer unavailable');
    expect(io.post).not.toHaveBeenCalled();
    expect(imported).not.toHaveBeenCalled();
    await read();
    expect(document.body.textContent).toContain(candidates[0].baseUrl);
    expect(imported).not.toHaveBeenCalled();
});
it.each(['expired', 'foreign'] as const)('does not import a %s snapshot', async (mode) => {
    const job = result();
    if (mode === 'expired') job.result.expiresAt = '2020-01-01T00:00:00Z';
    else job.result.deviceId = 'other-device';
    io.create.mockResolvedValue(job);
    await render();
    await read();
    for (const button of buttons('Импортировать')) {
        expect(button.disabled).toBe(true);
        await act(async () => button.click());
    }
    expect(io.post).not.toHaveBeenCalled();
    expect(imported).not.toHaveBeenCalled();
});
it('does not preview a credential-bearing endpoint', async () => {
    const job = result();
    job.result.candidates = [{ ...candidates[0], baseUrl: 'https://user:private@example.test/v1' }];
    io.create.mockResolvedValue(job);
    await render();
    await read();
    expect(document.body.textContent).not.toContain('private');
});
