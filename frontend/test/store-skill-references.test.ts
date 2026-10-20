import { describe, expect, it } from 'vitest';
import type { IProjectAsset, ISkillListSummary } from '../src/core/api/interfaces';
import type { IStoreApp } from '../src/modules/Store/AppCard';
import { fromSkill, isToolInProject, projectAssetForTool, resolveStoreSkillReference } from '../src/modules/Store/storeHelpers';
import { unavailableProjectAssets } from '../src/modules/Store/selectUnavailableProjectAssets';

const skill = (path: string, skillSlug = path.split('/').at(-1)!): IStoreApp => ({ id: path, path, skillSlug, name: 'Новое название',
    kind: 'skill', description: '', version: 1, tags: [], origin: '' });
const asset = (assetId: string, assetKind: IProjectAsset['assetKind'] = 'skill'): IProjectAsset => ({ assetId, assetKind, addedBy: 'qa@example.test', addedAt: '' });
const common = skill('ops/rag-index-monitor');
const legacy = asset('rag-index-monitor');

describe('Проектное назначение скилла совпадает с серверным разрешением ссылок', () => {
    it('Переименование видимой карточки сохраняет технический slug и назначение', () => {
        const app = fromSkill({ path: common.path!, meta: { name: 'Монитор базы знаний', slug: 'rag-index-monitor' } } as ISkillListSummary);
        expect(app.skillSlug).toBe('rag-index-monitor');
        expect(isToolInProject(app, 'prj-own', [asset(app.id)], [app])).toBe(true);
        expect(projectAssetForTool(app, 'prj-own', [asset(app.id)], [app])?.assetId).toBe(app.id);
    });

    it('Старое назначение разрешается и по техническому slug, отличающемуся от basename', () => {
        const app = skill('ops/renamed-path', 'rag-index-monitor');
        expect(isToolInProject(app, 'prj-own', [legacy], [app])).toBe(false);
    });

    it('Старая карточка без метаданных использует basename пути, а не видимое название', () => {
        const app = { ...common, skillSlug: undefined };
        expect(isToolInProject(app, 'prj-own', [legacy], [app])).toBe(false);
        expect(isToolInProject({ ...app, name: 'Fake alias' }, 'prj-own', [asset('fake-alias')], [app])).toBe(false);
    });

    it('Два общих кандидата не получают одобрение из одного короткого имени', () => {
        const catalog = [common, skill('common/rag-index-monitor')];
        expect(catalog.map(app => isToolInProject(app, 'prj-own', [legacy], catalog))).toEqual([false, false]);
        expect(unavailableProjectAssets([legacy], catalog, 'prj-own')).toEqual([legacy]);
        expect(projectAssetForTool(common, 'prj-own', [legacy], catalog)).toBeUndefined();
    });

    it('Точный корневой путь имеет приоритет над одноимённым вложенным скиллом', () => {
        const root = skill('rag-index-monitor');
        const catalog = [common, root];
        expect(isToolInProject(root, 'prj-own', [legacy], catalog)).toBe(true);
        expect(isToolInProject(common, 'prj-own', [legacy], catalog)).toBe(false);
        expect(unavailableProjectAssets([legacy], catalog, 'prj-own')).toEqual([]);
    });

    it('Полное назначение не становится неоднозначным из-за похожих имён', () => {
        const catalog = [common, skill('common/rag-index-monitor'), skill('rag-index-monitor')];
        const assignment = asset(common.id);
        expect(catalog.map(app => isToolInProject(app, 'prj-own', [assignment], catalog))).toEqual([true, false, false]);
        expect(projectAssetForTool(common, 'prj-own', [assignment], catalog)).toBe(assignment);
    });

    it('Чужой проект не конкурирует с общим кандидатом и не получает доступ', () => {
        const foreign = skill('project-prj-other/rag-index-monitor');
        const catalog = [common, foreign];
        expect(isToolInProject(common, 'prj-own', [asset(common.id)], catalog)).toBe(true);
        expect(isToolInProject(foreign, 'prj-own', [legacy, asset(foreign.id)], catalog)).toBe(false);
        expect(resolveStoreSkillReference(legacy.assetId, [foreign])).toBeUndefined();
    });

    it('Собственный проектный скилл доступен без назначения, но не скрывает сломанную общую ссылку', () => {
        const own = skill('project-prj-own/rag-index-monitor');
        expect(isToolInProject(own, 'prj-own', [], [own])).toBe(true);
        expect(unavailableProjectAssets([legacy], [own], 'prj-own')).toEqual([legacy]);
    });

    it.each(['missing/rag-index-monitor', '../rag-index-monitor', 'project', 'project-prj-other'])('Неполная или чужая ссылка %s не подменяется общим скиллом', reference => {
        expect(resolveStoreSkillReference(reference, [common])).toBeUndefined();
    });

    it('Удаление использует исходный короткий ID, MCP и плагины требуют точного ID', () => {
        expect(projectAssetForTool(common, 'prj-own', [legacy], [common])).toBeUndefined();
        for (const kind of ['mcp', 'plugin'] as const) {
            const app = { ...common, kind, id: 'ai-plug-example', name: 'rag-index-monitor' };
            expect(isToolInProject(app, 'prj-own', [asset('rag-index-monitor', kind)], [app])).toBe(false);
            expect(isToolInProject(app, 'prj-own', [asset(app.id, kind)], [app])).toBe(true);
        }
    });
});
