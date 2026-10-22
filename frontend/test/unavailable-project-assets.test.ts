import { describe, expect, it } from 'vitest';
import type { IProjectAsset } from '../src/core/api/interfaces';
import type { IStoreApp } from '../src/features/Catalog/types';
import { unavailableProjectAssets } from '../src/modules/Store/selectUnavailableProjectAssets';
const asset = (assetId: string, assetKind: IProjectAsset['assetKind'] = 'skill'): IProjectAsset => ({ assetId, assetKind, addedBy: 'admin@example.test', addedAt: '2026-10-18T00:00:00Z' });
const skill = { id: 'common/helper', path: 'common/helper', name: 'Helper', kind: 'skill' } as IStoreApp;
describe('Недоступные назначения не исчезают из проектного каталога', () => {
    it('Отличает доступную карточку от отсутствующей и оставляет её ID для снятия ссылки', () => {
        expect(unavailableProjectAssets([asset('common/helper'), asset('common/missing')], [skill], 'prj-a')).toEqual([asset('common/missing')]);
    });
    it('Сохраняет совместимость старого slug назначения', () => {
        expect(unavailableProjectAssets([asset('helper')], [skill], 'prj-a')).toEqual([asset('helper')]);
    });
    it('Карточка другого типа не скрывает отсутствующий MCP с таким же ID', () => {
        expect(unavailableProjectAssets([asset('common/helper', 'mcp')], [skill], 'prj-a')).toHaveLength(1);
    });
    it('Повтор назначения даёт одну строку, разные типы остаются разными ссылками', () => {
        expect(unavailableProjectAssets([asset('missing'), asset('missing'), asset('missing', 'mcp')], [], 'prj-a')).toEqual([asset('missing'), asset('missing', 'mcp')]);
    });
    it('Чужой проектный скилл с похожим именем не скрывает сломанную общую ссылку', () => {
        const foreign = { ...skill, id: 'project-prj-other/helper', path: 'project-prj-other/helper' };
        expect(unavailableProjectAssets([asset('helper')], [foreign], 'prj-a')).toHaveLength(1);
    });
    it('Встроенный скилл своего проекта не скрывает постороннее отсутствующее назначение', () => {
        const owned = { ...skill, id: 'project-prj-a/helper', path: 'project-prj-a/helper' };
        expect(unavailableProjectAssets([asset('common/missing')], [owned], 'prj-a')).toHaveLength(1);
    });
});
