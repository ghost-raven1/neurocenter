import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    BackgroundContextError,
    ComputerContextProvider,
    ProjectContextProvider,
    TaskContext,
    WebContextProvider,
} from '../context';

describe('TaskContext (FR-305 context seam: project ships, computer/web are seams)', () => {
    const originalRoot = process.env.PROJECTS_ROOT;
    afterEach(() => {
        if (originalRoot === undefined) delete process.env.PROJECTS_ROOT;
        else process.env.PROJECTS_ROOT = originalRoot;
    });

    it('defaults to the project source when the payload names no context', async () => {
        const context = TaskContext.defaults();
        const { descriptors, root } = await context.prepare('prj-bg', undefined);
        expect(descriptors.map((descriptor) => descriptor.source)).toEqual(['project']);
        expect(descriptors[0].rendered).toContain(root);
        expect(path.isAbsolute(root)).toBe(true);
        expect(root.endsWith(path.join('prj-bg'))).toBe(true);
    });

    it('resolves requested sources in order and renders each descriptor', async () => {
        const context = TaskContext.defaults();
        const { descriptors } = await context.prepare('prj-bg', { project: { catalog: true }, web: { enabled: true } });
        expect(descriptors.map((descriptor) => descriptor.source)).toEqual(['project', 'web']);
        expect(descriptors[1].rendered).toMatch(/web/i);
    });

    it('computer context without a bridge fails explicitly (never silent, never a fake descriptor)', async () => {
        const context = TaskContext.defaults();
        await expect(context.prepare('prj-bg', { computer: {} })).rejects.toThrow(BackgroundContextError);
        await expect(context.prepare('prj-bg', { computer: {} })).rejects.toThrow(/мост/);
    });

    it('computer context with a bridge resolves through the provider', async () => {
        const context = new TaskContext([
            new ProjectContextProvider(),
            new ComputerContextProvider(() => true),
            new WebContextProvider(),
        ]);
        const { descriptors } = await context.prepare('prj-bg', { computer: {} });
        expect(descriptors.map((descriptor) => descriptor.source)).toEqual(['computer']);
    });

    it('a requested source without a provider fails explicitly (extension seam: add the provider to enable it)', async () => {
        const context = new TaskContext([new ProjectContextProvider()]);
        await expect(context.prepare('prj-bg', { web: {} })).rejects.toThrow(/не настроен/);
    });

    it('resolves the project root under PROJECTS_ROOT (single source for the runtime root)', async () => {
        const base = mkdtempSync(path.join(tmpdir(), 'nc-bg-ctx-'));
        process.env.PROJECTS_ROOT = base;
        const context = TaskContext.defaults();
        expect(context.root('prj-bg')).toBe(path.resolve(base, 'prj-bg'));
    });

    it('accepts an injected root resolver (the seam for a non-default deployment layout)', () => {
        const context = new TaskContext([new ProjectContextProvider()], (id) => `/custom/${id}`);
        expect(context.root('prj-bg')).toBe('/custom/prj-bg');
    });
});
