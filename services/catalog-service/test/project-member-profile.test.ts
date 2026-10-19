import {beforeEach,describe,expect,it,vi} from 'vitest';
import {AccessDb} from '../src/access/access-db';
import {CatalogController} from '../src/catalog/catalog.controller';
import type {CatalogService} from '../src/catalog/catalog.service';

const fixture=vi.hoisted(()=>({query:vi.fn(),release:vi.fn(),user:undefined as undefined|{
    email:string;display_name:string;is_main_admin:boolean;enabled:boolean;created_at:string;
}}));
vi.mock('../src/database/pool',()=>({createPool:()=>({connect:async()=>fixture})}));
const email='member@example.test',actor='admin@example.test';
const existing={email,display_name:'Иван Иванов',is_main_admin:true,enabled:false,created_at:'2026-10-19'};
const request={headers:{'x-bridge-principal':actor,
    'x-bridge-actor':encodeURIComponent(JSON.stringify({email:actor,activeRole:'Админ проекта'}))}};
const manager={userId:'u-admin',principalName:actor,displayName:'Администратор проекта',role:'Админ проекта',addedAt:'2026-10-19'};

describe('Проектное назначение сохраняет глобальный профиль сотрудника',()=>{
    const catalog={listProjectMembers:vi.fn(),addProjectMember:vi.fn()};
    let controller:CatalogController;

    beforeEach(()=>{
        vi.clearAllMocks();fixture.user={...existing};
        fixture.query.mockImplementation(async(sql:string,params?:unknown[])=>{
            if(sql.startsWith('SELECT * FROM platform_users'))return {rows:fixture.user?[{...fixture.user}]:[]};
            if(sql.startsWith('INSERT INTO platform_users')){
                fixture.user=fixture.user?{...fixture.user,display_name:String(params![4]??fixture.user.display_name)}:
                    {email:String(params![0]),display_name:String(params![1]),is_main_admin:params![2]===true,enabled:params![3]!==false,created_at:'2026-10-19'};
                const row=fixture.user;
                return {rows:[{email:row.email,displayName:row.display_name,isMainAdmin:row.is_main_admin,enabled:row.enabled,createdAt:row.created_at}]};
            }
            return {rows:[]};
        });
        catalog.listProjectMembers.mockResolvedValue([manager]);
        catalog.addProjectMember.mockImplementation(async(_id,member)=>member);
        controller=new CatalogController(catalog as unknown as CatalogService,new AccessDb());
    });

    it.each([email,'Имя только в этом проекте'])('Не изменяет существующий профиль при проектном имени %s',async displayName=>{
        const member=await controller.addProjectMember('prj-test',{principalName:email,displayName,role:'Разработчик'},request);
        expect(member.displayName).toBe(displayName);
        expect(fixture.user).toEqual(existing);
        expect(fixture.query.mock.calls.some(([sql])=>sql.startsWith('INSERT INTO platform_users'))).toBe(false);
        expect(fixture.query.mock.calls.some(([sql])=>sql.startsWith('INSERT INTO security_events'))).toBe(false);
        expect(fixture.query.mock.calls.at(-1)).toEqual(['COMMIT']);
    });

    it('Создаёт отсутствующий аккаунт без административных прав и с аудитом автора',async()=>{
        fixture.user=undefined;
        await controller.addProjectMember('prj-test',{principalName:email,displayName:'Новый сотрудник',role:'Разработчик'},request);
        expect(fixture.user).toMatchObject({email,display_name:'Новый сотрудник',is_main_admin:false,enabled:true});
        const event=fixture.query.mock.calls.find(([sql])=>sql.startsWith('INSERT INTO security_events'));
        expect(event?.[1].slice(1,4)).toEqual([actor,'user.create',email]);
        expect(catalog.addProjectMember).toHaveBeenCalledOnce();
    });

    it('Не создаёт назначение при отказе аудита создания аккаунта',async()=>{
        fixture.user=undefined;const original=fixture.query.getMockImplementation()!;
        fixture.query.mockImplementation(async(sql:string,params?:unknown[])=>{
            if(sql.startsWith('INSERT INTO security_events'))throw new Error('Журнал недоступен');
            return original(sql,params);
        });
        await expect(controller.addProjectMember('prj-test',{principalName:email,role:'Разработчик'},request)).rejects.toThrow('Журнал недоступен');
        expect(catalog.addProjectMember).not.toHaveBeenCalled();
        expect(fixture.query.mock.calls.at(-1)).toEqual(['ROLLBACK']);
        expect(fixture.release).toHaveBeenCalledOnce();
    });
});
