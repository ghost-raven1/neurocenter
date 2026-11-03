import { describe, expect, it } from 'vitest';
import { projectUpdateBatchRows, projectUpdateInstallStatus, summarizePinOutcomes } from '../projectUpdateBatch';
import type { IStoreApp } from '../../../features/Catalog/interfaces';
import type { IProjectAsset } from '../../../core/api/interfaces';
import type { IBridgeJob } from '../../../features/McpBridge/api';

const head: IStoreApp = {
    id: 'tool-1',
    name: 'Tool',
    kind: 'mcp',
    description: '',
    version: 3,
    tags: [],
    origin: 'catalog',
};
const ref: IProjectAsset = {
    assetId: 'tool-1',
    assetKind: 'mcp',
    addedBy: 'admin',
    addedAt: '2026-11-01T00:00:00Z',
    version: 2,
    manifest: 'm2',
};
const projects = [{ id: 'p1', name: 'Проект', canManage: true }];
const byProject = { p1: [ref] };
const baseOptions = { projects, byProject, common: [head], catalogReady: true };

describe('projectUpdateBatchRows', () => {
    it('offers the exact newer catalog revision per managed project', () => {
        expect(projectUpdateBatchRows(baseOptions)).toEqual([
            expect.objectContaining({
                projectId: 'p1',
                projectName: 'Проект',
                assetId: 'tool-1',
                assetKind: 'mcp',
                name: 'Tool',
                from: 2,
                to: 3,
                expectedVersion: 2,
                expectedManifest: 'm2',
                head,
                ref,
            }),
        ]);
    });
    it.each([
        'not behind',
        'equal versions',
        'catalog not ready',
        'without manage rights',
        'pinError',
        'unknown pin version',
    ])('%s keeps the row out of the batch', (which) => {
        const overrides: Record<string, Partial<typeof baseOptions>> = {
            'not behind': { common: [{ ...head, version: 1 }] },
            'equal versions': { common: [{ ...head, version: 2 }] },
            'catalog not ready': { catalogReady: false },
            'without manage rights': { projects: [{ ...projects[0], canManage: false }] },
            pinError: { byProject: { p1: [{ ...ref, pinError: 'конфликт' }] } },
            'unknown pin version': { byProject: { p1: [{ ...ref, version: null }] } },
        };
        expect(projectUpdateBatchRows({ ...baseOptions, ...overrides[which] })).toEqual([]);
    });
    it('keeps an asset that disappeared from the common catalog out of the batch', () => {
        expect(projectUpdateBatchRows({ ...baseOptions, common: [] })).toEqual([]);
    });
    it('collects rows across projects and assets in a stable order', () => {
        const skillHead: IStoreApp = { ...head, id: 'skill-1', name: 'Skill', kind: 'skill', version: 2 };
        const skillRef: IProjectAsset = { ...ref, assetId: 'skill-1', assetKind: 'skill', version: 1, manifest: null };
        const rows = projectUpdateBatchRows({
            projects: [projects[0], { id: 'p2', name: 'Второй', canManage: true }],
            byProject: { p1: [ref, skillRef], p2: [ref] },
            common: [head, skillHead],
            catalogReady: true,
        });
        expect(rows.map((row) => `${row.projectId}:${row.assetId}`)).toEqual(['p1:tool-1', 'p1:skill-1', 'p2:tool-1']);
        expect(rows[1]).toEqual(
            expect.objectContaining({
                name: 'Skill',
                from: 1,
                to: 2,
                expectedVersion: 1,
                expectedManifest: null,
            }),
        );
    });
});

const job = (patch: Partial<IBridgeJob> = {}): IBridgeJob => ({
    id: 'job-1',
    deviceId: 'dev-1',
    projectId: 'p1',
    kind: 'install',
    state: 'queued',
    message: '',
    assetId: 'tool-1',
    assetKind: 'mcp',
    version: '3',
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
    ...patch,
});

describe('projectUpdateInstallStatus', () => {
    const target = { projectId: 'p1', assetId: 'tool-1', assetKind: 'mcp', version: 3 };
    it('stays idle without installation jobs for the target', () => {
        expect(projectUpdateInstallStatus([], target)).toBe('idle');
        expect(projectUpdateInstallStatus([job({ projectId: 'p2' })], target)).toBe('idle');
        expect(projectUpdateInstallStatus([job({ assetId: 'other' })], target)).toBe('idle');
        expect(projectUpdateInstallStatus([job({ kind: 'uninstall' })], target)).toBe('idle');
    });
    it.each([
        ['queued', 'queued'],
        ['running', 'running'],
        ['reconciling', 'running'],
        ['succeeded', 'succeeded'],
        ['failed', 'failed'],
        ['cancelled', 'failed'],
    ])('maps the %s job state for the offered revision', (state, expected) => {
        expect(projectUpdateInstallStatus([job({ state })], target)).toBe(expected);
    });
    it('follows the newest job when several were sent', () => {
        expect(
            projectUpdateInstallStatus(
                [
                    job({ state: 'failed', updatedAt: '2026-11-01T00:00:00Z' }),
                    job({ id: 'job-2', state: 'succeeded', updatedAt: '2026-11-01T01:00:00Z' }),
                ],
                target,
            ),
        ).toBe('succeeded');
    });
    it('does not count a finished install of the older revision as the update', () => {
        // The asset is installed on v2; the offered v3 has no job yet.
        expect(projectUpdateInstallStatus([job({ version: '2', state: 'succeeded' })], target)).toBe('idle');
    });
    it('reports the offered revision once its own job finishes', () => {
        expect(
            projectUpdateInstallStatus(
                [
                    job({ version: '2', state: 'succeeded', updatedAt: '2026-11-01T00:00:00Z' }),
                    job({ id: 'job-2', version: '3', state: 'succeeded', updatedAt: '2026-11-01T01:00:00Z' }),
                ],
                target,
            ),
        ).toBe('succeeded');
        expect(
            projectUpdateInstallStatus(
                [
                    job({ version: '2', state: 'succeeded', updatedAt: '2026-11-01T00:00:00Z' }),
                    job({ id: 'job-2', version: '3', state: 'failed', updatedAt: '2026-11-01T01:00:00Z' }),
                ],
                target,
            ),
        ).toBe('failed');
    });
    it('keeps the in-flight state regardless of the job revision', () => {
        expect(projectUpdateInstallStatus([job({ version: '2', state: 'running' })], target)).toBe('running');
        expect(projectUpdateInstallStatus([job({ version: '2', state: 'queued' })], target)).toBe('queued');
    });
});

describe('summarizePinOutcomes', () => {
    const rows = projectUpdateBatchRows(baseOptions);
    it('counts only finished rows', () => {
        expect(summarizePinOutcomes(rows, new Map())).toEqual({ total: 1, ok: 0, conflict: 0, error: 0 });
    });
    it('separates ok, conflict, and error outcomes', () => {
        const [row] = rows;
        expect(summarizePinOutcomes(rows, new Map([[row.key, { key: row.key, state: 'conflict' as const }]]))).toEqual({
            total: 1,
            ok: 0,
            conflict: 1,
            error: 0,
        });
        expect(summarizePinOutcomes(rows, new Map([[row.key, { key: row.key, state: 'ok' as const }]]))).toEqual({
            total: 1,
            ok: 1,
            conflict: 0,
            error: 0,
        });
    });
});
