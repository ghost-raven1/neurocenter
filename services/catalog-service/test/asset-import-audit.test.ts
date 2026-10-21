import {describe, expect, it, vi} from 'vitest';
import type {Pool} from 'pg';
import {assetImportAuditSnapshot} from '../src/catalog/asset-import-audit';
import {listAuditHistory} from '../src/catalog/audit-history';

describe('Исторические названия выбранных ассетов', () => {
    it('Разрешает только идентичность выбранных позиций и не раскрывает содержимое/секреты', () => {
        const snapshot = assetImportAuditSnapshot({ids: ['selected'], repository: 'owner/assets', commit: 'a'.repeat(40), token: 'private'}, [
            {assetId: 'selected', name: 'Имя при импорте', kind: 'mcp', version: '1.2.3', payload: {headers: {authorization: 'private'}}, files: ['source']},
            {assetId: 'dependency', name: 'Не выбран отдельно', kind: 'plugin', version: '2'},
            {assetId: 'selected', name: 'Дублированная позиция', kind: 'mcp', version: '2'},
        ]);
        expect(snapshot).toEqual({ids: ['selected'], repository: 'owner/assets', commit: 'a'.repeat(40), items: [{assetId: 'selected', name: 'Имя при импорте', kind: 'mcp', version: '1.2.3'}]});
        expect(JSON.stringify(snapshot)).not.toMatch(/private|payload|headers|authorization|files|dependency/);
    });
    it.each([undefined, null, [], 'invalid', {items: 'bad'}])('Удалённый/неполный снимок %s не выдумывает имена', raw => {
        expect(assetImportAuditSnapshot({ids: ['one', 'two']}, raw)).toEqual({ids: ['one', 'two'], items: []});
    });
    it('Не выдаёт повреждённые имена, типы и версии за сохранённые данные', () => {
        expect(assetImportAuditSnapshot({ids: ['one'], commit: 'private'}, [{assetId: 'one', name: ['bad'], kind: 'model', version: '1'}, {assetId: 'one', name: 'Bad', kind: 'other', version: '1'}])).toEqual({ids: ['one'], items: []});
    });
    it('Страница истории читает job одним пакетным запросом и возвращает безопасный снимок', async () => {
        const event = {id: 'security:one', action: 'asset.import.request', resourceId: 'job-1', details: {before: null, after: {ids: ['source-1'], repository: 'owner/assets', commit: 'a'.repeat(40), private: true}}};
        const query = vi.fn(async(sql: string) => sql.includes('::int AS n') ? {rows: [{n: 1}]} : sql.includes('FROM asset_source_jobs jobs') ? {rows: [{id: 'job-1', items: [{assetId: 'source-1', name: 'Старое имя', kind: 'agent', version: '1', payload: 'private'}]}]} : {rows: [event]});
        const result = await listAuditHistory({query} as unknown as Pool, 1, 20);
        expect(result.items[0].details).toEqual({before: null, after: {ids: ['source-1'], repository: 'owner/assets', commit: 'a'.repeat(40), items: [{assetId: 'source-1', name: 'Старое имя', kind: 'agent', version: '1'}]}});
        expect(query).toHaveBeenCalledTimes(3); expect(query).toHaveBeenLastCalledWith(expect.stringContaining('FROM asset_source_jobs jobs'), [['job-1']]);
        expect(query.mock.calls.at(-1)?.[0]).not.toMatch(/ai_plugins|catalog_agents|model_remote_connections|publication|payload/);
        expect(JSON.stringify(result)).not.toContain('private');
    });
    it('Отсутствующий job сохраняет число выбранных позиций из security-события', async () => {
        const event = {id: 'security:one', action: 'asset.import.request', resourceId: 'deleted-job', details: {before: null, after: {ids: ['one', 'two']}}};
        const query = vi.fn(async(sql: string) => sql.includes('::int AS n') ? {rows: [{n: 1}]} : sql.includes('FROM asset_source_jobs jobs') ? {rows: []} : {rows: [event]});
        expect((await listAuditHistory({query} as unknown as Pool, 1, 20)).items[0].details).toEqual({before: null, after: {ids: ['one', 'two'], items: []}});
    });
});
