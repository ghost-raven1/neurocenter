import {describe, expect, it} from 'vitest';
import type {IAiPlugin, IProjectAsset} from '../src/core/api/interfaces';
import type {IStoreApp} from '../src/features/Catalog/types';
import type {IBridgeInstallation, IBridgeJob} from '../src/features/McpBridge/api';
import {projectCatalogUpdate, showProjectCatalogUpdate} from '../src/modules/Store/projectCatalogUpdates';

const app: IStoreApp = {id: 'rag', name: 'OpenCodeRAG', kind: 'plugin', version: 1, revision: '2.11.0', description: '', origin: '', tags: []};
const project: IProjectAsset = {assetId: app.id, assetKind: app.kind, version: 1, manifest: 'a'.repeat(64),
    card: {...app, config: null, files: [], compatibility: null, createdAt: '', updatedAt: ''} as IAiPlugin, addedBy: 'admin', addedAt: ''};
const receipt: IBridgeInstallation = {deviceId: 'computer', projectId: 'project', bindingId: 'folder', assetId: app.id,
    assetKind: app.kind, version: 1, name: app.name, manifest: project.manifest!, updatedAt: ''};
const setup = (): Parameters<typeof projectCatalogUpdate>[1] => ({common: [{...app, version: 2, revision: '2.12.2'}], assets: [project], installations: [receipt], jobs: [] as IBridgeJob[],
    target: {deviceId: receipt.deviceId, projectId: receipt.projectId, bindingId: receipt.bindingId, assetId: app.id, assetKind: app.kind},
    sourceReady: true, projectReady: true, receiptsReady: true});

describe('Предложения сохраняют границы каталога, проекта и квитанции компьютера', () => {
    it('Новое издание не меняет pin и не выдаёт прежнюю локальную версию за обновлённую', () => {
        const options = setup(), state = projectCatalogUpdate(app, options)!;
        expect(state).toMatchObject({head: {version: 2, revision: '2.12.2'}, project: {version: 1}, computer: {version: 1}, catalogNewer: true, computerDiffers: false});
        expect(options.assets[0]).toBe(project); expect(options.installations[0]).toBe(receipt); expect(showProjectCatalogUpdate(state)).toBe(true);
    });
    it('Закрепление v2 оставляет локальное обновление до точной квитанции v2 и manifest', () => {
        const options = setup(), next = {...project, version: 2, manifest: 'b'.repeat(64)};
        options.assets = [next];
        expect(projectCatalogUpdate({...app, version: 2}, options)).toMatchObject({catalogNewer: false, computerDiffers: true});
        options.installations = [{...receipt, version: 2}];
        expect(projectCatalogUpdate({...app, version: 2}, options)?.computerDiffers).toBe(true);
        options.installations = [{...receipt, version: 2, manifest: next.manifest}];
        expect(showProjectCatalogUpdate(projectCatalogUpdate({...app, version: 2}, options))).toBe(false);
    });
    it.each([{deviceId: 'other'}, {projectId: 'other'}, {bindingId: 'old'}, {assetId: 'other'}, {legacyBinding: true}, {bindingChanged: true}, {isCurrentBinding: false}])('Чужая или прежняя квитанция %# не подтверждает локальную версию', change => {
        const options = setup(); options.installations = [{...receipt, ...change}];
        expect(projectCatalogUpdate(app, options)).toMatchObject({computer: undefined, computerDiffers: false});
    });
    it('Ошибка чтения и неподтверждённая папка не превращают прежнюю квитанцию в текущую', () => {
        const options = setup(); options.receiptsReady = false;
        expect(projectCatalogUpdate(app, options)?.computer).toBeUndefined();
        options.receiptsReady = true; options.target.bindingId = null;
        expect(projectCatalogUpdate(app, options)).toMatchObject({receiptsReady: false, computer: undefined});
        options.sourceReady = false;
        expect(projectCatalogUpdate(app, options)).toMatchObject({head: undefined, catalogNewer: false});
    });
    it.each(['queued', 'running', 'reconciling', 'failed', 'cancelled', 'conflict'])('Фильтр сохраняет %s, даже когда предложение уже закреплено', state => {
        const options = setup(); options.common = [app];
        options.jobs = [{...receipt, id: 'job', kind: 'install', version: '1', state, message: 'Нужно завершить действие', createdAt: '', updatedAt: ''}];
        const update = projectCatalogUpdate(app, options)!;
        expect(update).toMatchObject({catalogNewer: false, computerDiffers: false, attention: true}); expect(showProjectCatalogUpdate(update)).toBe(true);
    });
    it('Неподтверждённый pin не обещает обновление и сохраняет восстановление', () => {
        const options = setup(); options.assets = [{...project, version: null, manifest: null, card: undefined, pinError: 'Подтвердите версию'}];
        expect(projectCatalogUpdate({...app, pinError: 'Подтвердите версию'}, options)).toMatchObject({catalogNewer: false, computerDiffers: false, attention: true});
        options.projectReady = false;
        expect(projectCatalogUpdate(app, options)?.catalogNewer).toBe(false);
    });
    it('Понижение общего head и отсутствие назначения не становятся обновлением', () => {
        const options = setup(); options.common = [{...app, version: 1}];
        expect(projectCatalogUpdate({...app, version: 3}, {...options, assets: [{...project, version: 3}], installations: []})?.catalogNewer).toBe(false);
        expect(projectCatalogUpdate(app, {...options, assets: []})).toBeUndefined();
    });
});
