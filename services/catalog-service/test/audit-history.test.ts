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
});
