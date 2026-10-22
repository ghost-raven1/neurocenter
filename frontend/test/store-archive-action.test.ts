import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StoreArchiveAction, storeArchiveTarget } from '../src/modules/Store/StoreArchiveAction';
import type { ArchiveAssetButton } from '../src/features/AssetManagement/ArchiveAssetButton';
import type { IStoreApp } from '../src/features/Catalog/types';
const ui = vi.hoisted(() => ({ props: undefined as ComponentProps<typeof ArchiveAssetButton> | undefined }));
vi.mock('../src/features/AssetManagement/ArchiveAssetButton', () => ({ ArchiveAssetButton: (props: ComponentProps<typeof ArchiveAssetButton>) => { ui.props = props; return props.children; } }));
const app = (kind: IStoreApp['kind'], id = kind === 'skill' ? 'common/reviewer' : 'opencode-rag'): IStoreApp => ({ kind, id, name: 'OpenCodeRAG', description: '', origin: '', version: 1, tags: [] });
beforeEach(() => { ui.props = undefined; });
describe('Common tool catalog archive action', () => {
    it.each(['mcp', 'plugin', 'skill'] as const)('offers explicit common deletion for %s to main admin using the existing impact flow', kind => {
        const target = app(kind), archived = vi.fn();
        const html = renderToStaticMarkup(createElement(StoreArchiveAction, { app: target, common: [target], isMain: true, onArchived: archived }));
        expect(html).toContain('Удалить из общего каталога'); expect(ui.props).toMatchObject({ kind, id: target.id, buttonProps: { block: true, 'aria-label': 'Удалить из общего каталога: OpenCodeRAG' } });
        expect(archived).not.toHaveBeenCalled(); ui.props?.onArchived?.(); expect(archived).toHaveBeenCalledOnce();
    });
    it('a project role cannot archive the common source even if it can edit its project skill', () => {
        for (const kind of ['mcp', 'plugin', 'skill'] as const) { const target = app(kind); expect(storeArchiveTarget(target, [target], false)).toBeUndefined(); }
    });
    it('an orphaned historical pin and project-owned skill never offer common-catalog deletion', () => {
        const target = app('plugin'); expect(storeArchiveTarget(target, [], true)).toBeUndefined();
        const skill = app('skill', 'project-prj-one/reviewer'); expect(storeArchiveTarget(skill, [skill], true)).toBeUndefined();
    });
    it('a project pin of an available source manages the source identity and preserves its independent pin', () => {
        const head = app('plugin'), pin = { ...head, version: 0, projectManifest: 'a'.repeat(64) };
        expect(storeArchiveTarget(pin, [head], true)).toBe(head); expect(pin.version).toBe(0);
        renderToStaticMarkup(createElement(StoreArchiveAction, { app: pin, common: [head], isMain: true, disabled: true, block: false, onArchived: vi.fn() }));
        expect(ui.props).toMatchObject({ disabled: true, buttonProps: { block: false } });
    });
});
