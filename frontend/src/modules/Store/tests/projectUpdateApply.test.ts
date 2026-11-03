import { describe, expect, it } from 'vitest';
import { autoInspectCandidates, projectUpdateApplyTarget } from '../projectUpdateApply';
import type { IStoreApp } from '../../../features/Catalog/interfaces';
import type { IProjectAsset } from '../../../core/api/interfaces';
import type { IBridgeInstallation, IBridgeJob } from '../../../features/McpBridge/api';

const app: IStoreApp = {
    id: 'tool-1',
    name: 'Tool',
    kind: 'mcp',
    description: '',
    version: 2,
    tags: [],
    origin: 'catalog',
};
const head: IStoreApp = { ...app, version: 3 };
const ref: IProjectAsset = {
    assetId: 'tool-1',
    assetKind: 'mcp',
    addedBy: 'admin',
    addedAt: '2026-11-01T00:00:00Z',
    version: 2,
    manifest: 'm2',
    card: {} as IProjectAsset['card'],
};
const baseOptions = {
    applyEnabled: true,
    selected: true,
    canManage: true,
    targetProjectId: 'p1',
    catalogReady: true,
    common: [head],
    assets: [ref],
};

describe('projectUpdateApplyTarget', () => {
    it('offers the exact newer catalog revision for a managed project card', () => {
        expect(projectUpdateApplyTarget(app, baseOptions)).toEqual({ head, ref });
    });
    it.each([
        'flag disabled',
        'card not selected',
        'without manage rights',
        'without project target',
        'catalog not ready',
    ])('%s keeps the separate actions', (which) => {
        const overrides: Record<string, Partial<typeof baseOptions>> = {
            'flag disabled': { applyEnabled: false },
            'card not selected': { selected: false },
            'without manage rights': { canManage: false },
            'without project target': { targetProjectId: undefined },
            'catalog not ready': { catalogReady: false },
        };
        expect(projectUpdateApplyTarget(app, { ...baseOptions, ...overrides[which] })).toBeUndefined();
    });
    it('keeps pinError and unknown states on the recovery actions', () => {
        expect(projectUpdateApplyTarget({ ...app, pinError: 'конфликт' }, baseOptions)).toBeUndefined();
        expect(projectUpdateApplyTarget(app, { ...baseOptions, common: [] })).toBeUndefined();
        expect(projectUpdateApplyTarget(app, { ...baseOptions, assets: [] })).toBeUndefined();
    });
    it('does not offer an apply when the project is not behind', () => {
        expect(projectUpdateApplyTarget(app, { ...baseOptions, common: [app] })).toBeUndefined();
        expect(projectUpdateApplyTarget(app, { ...baseOptions, common: [{ ...app, version: 1 }] })).toBeUndefined();
    });
});

const installation: IBridgeInstallation = {
    deviceId: 'd1',
    projectId: 'p1',
    assetId: 'tool-1',
    assetKind: 'mcp',
    version: 3,
    name: 'Tool',
    manifest: 'm3',
    updatedAt: '2026-11-02T00:00:00Z',
    bindingId: 'b1',
};
const installJob = (overrides: Partial<IBridgeJob> = {}): IBridgeJob => ({
    id: 'job-install',
    deviceId: 'd1',
    projectId: 'p1',
    kind: 'install',
    state: 'succeeded',
    message: 'done',
    assetId: 'tool-1',
    assetKind: 'mcp',
    version: '3',
    bindingId: 'b1',
    createdAt: '2026-11-02T00:00:00Z',
    updatedAt: '2026-11-02T00:05:00Z',
    ...overrides,
});
const inspectJob = (overrides: Partial<IBridgeJob> = {}): IBridgeJob => ({
    id: 'job-inspect',
    deviceId: 'd1',
    projectId: 'p1',
    kind: 'inspect-installation',
    state: 'succeeded',
    message: 'ok',
    assetId: 'tool-1',
    assetKind: 'mcp',
    bindingId: 'b1',
    expectedManifest: 'm3',
    createdAt: '2026-11-02T01:00:00Z',
    updatedAt: '2026-11-02T01:01:00Z',
    ...overrides,
});
const options = { projectId: 'p1', bindingId: 'b1', deviceReady: true, already: new Set<string>() };

describe('autoInspectCandidates', () => {
    it('enqueues one inspection for a succeeded install of the current revision', () => {
        const found = autoInspectCandidates([installJob()], [installation], options);
        expect(found).toHaveLength(1);
        expect(found[0].job.id).toBe('job-install');
        expect(found[0].row.manifest).toBe('m3');
    });
    it.each([
        ['install still running', installJob({ state: 'running' })],
        ['uninstall job', installJob({ kind: 'uninstall' })],
        ['other project', installJob({ projectId: 'p2' })],
        ['other folder', installJob({ bindingId: 'b2' })],
        ['bridge not ready', undefined],
    ] as const)('does not inspect when %s', (which, job) => {
        const found = autoInspectCandidates(
            job ? [job] : [installJob()],
            [installation],
            which === 'bridge not ready' ? { ...options, deviceReady: false } : options,
        );
        expect(found).toHaveLength(0);
    });
    it('skips an install that did not produce the current revision', () => {
        expect(autoInspectCandidates([installJob({ version: '2' })], [installation], options)).toHaveLength(0);
    });
    it('skips while an inspection is pending', () => {
        expect(
            autoInspectCandidates([installJob(), inspectJob({ state: 'running' })], [installation], options),
        ).toHaveLength(0);
    });
    it('skips a newer completed inspection of the same manifest', () => {
        expect(
            autoInspectCandidates(
                [installJob(), inspectJob({ createdAt: '2026-11-02T02:00:00Z' })],
                [installation],
                options,
            ),
        ).toHaveLength(0);
    });
    it('skips an install without a version in the job record', () => {
        expect(autoInspectCandidates([installJob({ version: undefined })], [installation], options)).toHaveLength(0);
    });
    it('skips when the installation row no longer exists', () => {
        expect(autoInspectCandidates([installJob()], [], options)).toHaveLength(0);
    });
    it('skips an installation without an active binding', () => {
        expect(
            autoInspectCandidates([installJob({ bindingId: undefined })], [{ ...installation, bindingId: undefined }], {
                ...options,
                bindingId: null,
            }),
        ).toHaveLength(0);
    });
    it('offers one inspection per distinct succeeded install job', () => {
        const found = autoInspectCandidates(
            [installJob({ id: 'first' }), installJob({ id: 'second' })],
            [installation],
            options,
        );
        expect(found.map((item) => item.job.id)).toEqual(['first', 'second']);
    });
    it('re-inspects when the finished inspection belongs to an older state', () => {
        expect(
            autoInspectCandidates(
                [
                    inspectJob({
                        id: 'old',
                        createdAt: '2026-11-01T00:00:00Z',
                        updatedAt: '2026-11-01T00:01:00Z',
                        expectedManifest: 'm2',
                    }),
                    installJob(),
                ],
                [installation],
                options,
            ),
        ).toHaveLength(1);
    });
    it('sends the same install once per session', () => {
        const already = new Set<string>(['job-install']);
        expect(autoInspectCandidates([installJob()], [installation], { ...options, already })).toHaveLength(0);
    });
});
