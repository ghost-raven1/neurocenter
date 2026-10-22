import {beforeEach,describe,expect,it,vi} from 'vitest';
import {authorizeAccessWrite} from '../src/access/access-write-policy';

describe('Fresh administrative write authority',()=>{
    const query=vi.fn();
    let account:unknown,grant:unknown;
    beforeEach(()=>{account={enabled:true,is_main_admin:true};grant={role:'Админ проекта'};query.mockReset().mockImplementation(async(sql:string)=>({rows:sql.startsWith('SELECT enabled,is_main_admin')?account?[account]:[]:sql.startsWith('SELECT role FROM project_members')?grant?[grant]:[]:[]}));});
    it.each([undefined,null,{email:'not-email',activeRole:'Главный админ'}])('rejects malformed actor before consulting the database %#',async actor=>{
        await expect(authorizeAccessWrite({query} as never,actor as never)).rejects.toMatchObject({status:403});expect(query).not.toHaveBeenCalled();
    });
    it.each([undefined,{enabled:false,is_main_admin:true}])('rejects a missing or disabled account %#',async value=>{
        account=value;await expect(authorizeAccessWrite({query} as never,{email:'admin@example.test',activeRole:'Главный админ'})).rejects.toMatchObject({status:403});
    });
    it('does not restore a revoked platform role',async()=>{
        account={enabled:true,is_main_admin:false};await expect(authorizeAccessWrite({query} as never,{email:'admin@example.test',activeRole:'Главный админ'})).rejects.toMatchObject({status:403});
    });
    it.each(['Наблюдатель','Разработчик','invented'])('cannot elevate the active %s role from an account-level main privilege',async activeRole=>{
        await expect(authorizeAccessWrite({query} as never,{email:'admin@example.test',activeRole},'prj-qa')).rejects.toMatchObject({status:403});
    });
    it('does not let a project role administer platform users without a project scope',async()=>{
        await expect(authorizeAccessWrite({query} as never,{email:'admin@example.test',activeRole:'Админ проекта'})).rejects.toMatchObject({status:403});
    });
    it.each([undefined,{role:'Наблюдатель'},{role:'Главный админ'}])('rejects a removed, downgraded or malformed project grant %#',async value=>{
        grant=value;await expect(authorizeAccessWrite({query} as never,{email:'admin@example.test',activeRole:'Админ проекта'},'prj-qa')).rejects.toMatchObject({status:403});
    });
    it('keeps the trusted active role and normalizes the identity used for the transactional read',async()=>{
        const actor={email:' Admin@Example.test ',activeRole:'Главный админ'};expect(await authorizeAccessWrite({query} as never,actor)).toEqual({email:'admin@example.test',activeRole:actor.activeRole});
        expect(query.mock.calls[0]).toEqual(['SELECT pg_advisory_xact_lock(72465381)']);expect(query.mock.calls[1]).toEqual(['SELECT enabled,is_main_admin FROM platform_users WHERE email=$1 FOR SHARE',['admin@example.test']]);
    });
    it('requires the exact current project assignment for the chosen project-administrator role',async()=>{
        account={enabled:true,is_main_admin:false};const actor={email:'admin@example.test',activeRole:'Админ проекта'};expect(await authorizeAccessWrite({query} as never,actor,'prj-qa')).toEqual(actor);
        expect(query.mock.calls.at(-1)).toEqual(['SELECT role FROM project_members WHERE project_id=$1 AND lower(principal_name)=$2 FOR SHARE',['prj-qa',actor.email]]);
    });
});
