import {describe,expect,it,vi} from 'vitest';
import type {Pool} from 'pg';
import {listAuditHistory} from '../src/catalog/audit-history';
describe('Общая история действий',()=>{
    it('Объединяет операции и security-события с общей пагинацией',async()=>{
        const event={id:'security:test',action:'maintenance.policy.update',correlationId:'',source:'security',details:{before:{revision:1},after:{revision:2}}};
        const query=vi.fn(async(sql:string)=>sql.includes('::int AS n')?{rows:[{n:11}]}:{rows:[event]});
        expect(await listAuditHistory({query} as unknown as Pool,2,5)).toEqual({items:[event],page:2,size:5,total:11});
        expect(query.mock.calls[1][0]).toContain('UNION ALL');expect(query.mock.calls[1][0]).toContain("WHEN action='maintenance.policy.update'");expect(query).toHaveBeenLastCalledWith(expect.stringContaining('ORDER BY at DESC,id DESC'),[5,5]);
    });
    it('Возвращает исторические сведения публикации без исходников и скрытых параметров', async () => {
        const event = { id: 'security:publication', action: 'plugin.update', source: 'security', details: {
            before: { name: 'Прежнее имя', kind: 'mcp', version: 3, filesCount: 1, config: { token: 'secret' } },
            after: { name: 'Имя в момент обновления', kind: 'plugin', version: 4, filesCount: 2, contentHash: 'hash',
                files: [{ content: 'private source' }], environment: { TOKEN: 'secret' } },
        } };
        const query = vi.fn(async (sql: string) => sql.includes('::int AS n') ? { rows: [{ n: 1 }] } : { rows: [event] });
        const result = await listAuditHistory({ query } as unknown as Pool, 1, 20);
        expect(result.items[0].details).toEqual({
            before: { name: 'Прежнее имя', kind: 'mcp', version: 3, filesCount: 1 },
            after: { name: 'Имя в момент обновления', kind: 'plugin', version: 4, filesCount: 2, contentHash: 'hash' },
        });
        expect(JSON.stringify(result)).not.toMatch(/secret|private source|environment|config/);
    });
    it('Сохраняет название удалённого инструмента из снимка до удаления', async () => {
        const event = { id: 'security:deleted', action: 'plugin.delete', details: { before: { name: 'Удалённый MCP', version: 2 }, after: null } };
        const query = vi.fn(async (sql: string) => sql.includes('::int AS n') ? { rows: [{ n: 1 }] } : { rows: [event] });
        const result = await listAuditHistory({ query } as unknown as Pool, 1, 20);
        expect(result.items[0].details).toEqual(event.details);
    });
    it('Не выдаёт повреждённые счётчики и неожиданные формы снимков за данные версии', async () => {
        const event = { id: 'security:invalid', action: 'plugin.update', details: { before: ['invalid'], after: { version: '4', filesCount: -1, name: { value: 'invalid' } } } };
        const query = vi.fn(async (sql: string) => sql.includes('::int AS n') ? { rows: [{ n: 1 }] } : { rows: [event] });
        const result = await listAuditHistory({ query } as unknown as Pool, 1, 20);
        expect(result.items[0].details).toEqual({ before: null, after: {} });
    });
});
