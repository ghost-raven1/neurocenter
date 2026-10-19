import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import UnavailableProjectAssets from '../src/modules/Store/UnavailableProjectAssets';
import type { IProjectAsset } from '../src/core/api/interfaces';

const ui = vi.hoisted(() => ({ actions: new Map<string, () => void>(), remove: vi.fn() }));
vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({ useAuthRequestOwner: () => ({ captureOwner: () => () => true }) }));
vi.mock('../src/core/api/bff', () => ({ default: { removeProjectAsset: ui.remove } }));
vi.mock('antd', async () => {
    const actual = await vi.importActual<typeof import('antd')>('antd');
    return { ...actual, Button: ({ children, onClick, disabled }: { children?: ReactNode; onClick: () => void; disabled?: boolean }) => {
        ui.actions.set(String(children), onClick);
        return createElement('button', { disabled }, children);
    } };
});
const asset = (assetKind: IProjectAsset['assetKind']): IProjectAsset => ({ assetId: 'missing-' + assetKind, assetKind, addedBy: 'audit@example.invalid', addedAt: '2026-10-19' });
const render = (assets: IProjectAsset[], canManage = true, onRecheck = vi.fn(async () => undefined)) =>
    renderToStaticMarkup(createElement(UnavailableProjectAssets, { projectId: 'prj-a', assets, canManage, onRecheck, onRemoved: vi.fn(async () => undefined) }));

beforeEach(() => { ui.actions.clear(); ui.remove.mockReset(); });

describe('Восстановление доступности назначенных инструментов', () => {
    it('Повторная проверка перечитывает каталог без удаления назначений', async () => {
        const recheck = vi.fn(async () => undefined);
        const html = render([asset('skill'), asset('mcp')], true, recheck);
        expect(html).toContain('Назначения сохранены');
        expect(html).toContain('Git их не переносит');
        expect(html).toContain('синхронизируйте каталог на сервере');
        expect(ui.remove).not.toHaveBeenCalled();
        await ui.actions.get('Проверить снова')!();
        expect(recheck).toHaveBeenCalledOnce();
        expect(ui.remove).not.toHaveBeenCalled();
    });
    it('Для скилла объясняет восстановление файлов без инструкции по MCP', () => {
        const html = render([asset('skill')]);
        expect(html).toContain('восстановите файлы скиллов');
        expect(html).not.toContain('синхронизируйте каталог на сервере');
    });
    it('Для плагина предлагает восстановить публикацию без предупреждения о скиллах', () => {
        const html = render([asset('plugin')]);
        expect(html).toContain('Пользовательские инструменты восстановите');
        expect(html).not.toContain('Git их не переносит');
    });
    it('Участник может перепроверить доступность, но не получает удаление ссылки', () => {
        const html = render([asset('skill')], false);
        expect(html).toContain('Попросите администратора');
        expect(ui.actions.has('Проверить снова')).toBe(true);
        expect(ui.actions.has('Убрать ссылку')).toBe(false);
    });
    it('Полный доступный состав не показывает предупреждение и действия', () => {
        expect(render([])).toBe('');
        expect(ui.actions.size).toBe(0);
    });
});
