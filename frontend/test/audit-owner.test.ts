import { configureStore } from '@reduxjs/toolkit';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import bffApi from '../src/core/api/bff';
import type { IAuditEvent } from '../src/core/api/interfaces';
import type { IAuthMe } from '../src/core/interfaces';
import { authInit, authLogout, authSwitchRole } from '../src/features/UserBlock/redux/actions';
import userBlock, { signOut } from '../src/features/UserBlock/redux/reducers';
import { fetchAudit } from '../src/modules/Audit/redux/actions';
import audit from '../src/modules/Audit/redux/reducers';

vi.mock('../src/core/api/bff',()=>({default:{me:vi.fn(),logout:vi.fn(),switchRole:vi.fn(),listAudit:vi.fn()}}));

const owner: IAuthMe = {
    user:{id:'one',email:'one@example.test',principalName:'one',displayName:'Первый',activeRole:'Главный администратор',
        userRoles:['Главный администратор','Администратор'],routePermissions:['audit'],projectRoles:[]},
    policies:{audit:['read'],projects:['read']},
};
const args={page:1,size:20};
const event = (id:string):IAuditEvent=>({id,at:'2026-10-18T00:00:00.000Z',actor:'operator@example.test',versionAuthor:'',
    action:'skill.create',resourceType:'skill',resourceId:'common/'+id,outcome:'SUCCEEDED',decisionId:'',correlationId:''});
const page=(id:string)=>({items:[event(id)],...args,total:1});
function deferred<T>(){
    let resolve!:(value:T)=>void;let reject!:(cause:unknown)=>void;
    const promise=new Promise<T>((done,fail)=>{resolve=done;reject=fail;});
    return {promise,resolve,reject};
}
async function setup(){
    const store=configureStore({reducer:{userBlock,audit}});
    vi.mocked(bffApi.me).mockResolvedValueOnce(owner);await store.dispatch(authInit());
    vi.mocked(bffApi.listAudit).mockResolvedValueOnce(page('known'));await store.dispatch(fetchAudit(args));
    return store;
}
const denied=(status:number)=>({isAxiosError:true,response:{status,data:{message:'Нет доступа'}}});

describe('Владелец Redux-истории действий',()=>{
    beforeEach(()=>vi.resetAllMocks());

    it('Выход очищает кэш и не принимает поздний HTTP-успех или новые вызовы без сессии',async()=>{
        const store=await setup();const old=deferred<ReturnType<typeof page>>();
        vi.mocked(bffApi.listAudit).mockReturnValueOnce(old.promise);const request=store.dispatch(fetchAudit(args));
        store.dispatch(signOut());old.resolve(page('private-old'));await request;
        const skipped=await store.dispatch(fetchAudit(args));
        expect(fetchAudit.rejected.match(skipped)&&skipped.meta.condition).toBe(true);
        expect(bffApi.listAudit).toHaveBeenCalledTimes(2);
        expect(store.getState().audit).toMatchObject({list:[],loadedPage:null,total:0,requestId:null,authScope:null,error:null,loading:false});
    });
    it('Подтверждённый logout отбрасывает прежний отказ чтения',async()=>{
        const store=await setup();const old=deferred<ReturnType<typeof page>>();
        vi.mocked(bffApi.listAudit).mockReturnValueOnce(old.promise);const request=store.dispatch(fetchAudit(args));
        vi.mocked(bffApi.logout).mockResolvedValueOnce({});await store.dispatch(authLogout());
        old.reject(new Error('Поздний отказ'));await request;
        expect(store.getState().audit).toMatchObject({list:[],error:null,authScope:null,loading:false});
    });
    it.each([
        ['аккаунт',{...owner,user:{...owner.user,id:'two',email:'two@example.test'}}],
        ['активная роль',{...owner,user:{...owner.user,activeRole:'Администратор'}}],
        ['политики',{...owner,policies:{audit:['read']}}],
    ] as const)('Смена владельца (%s) очищает прежний loadedPage и не принимает старый ответ',async(label,next)=>{
        const store=await setup();const old=deferred<ReturnType<typeof page>>();
        vi.mocked(bffApi.listAudit).mockReturnValueOnce(old.promise);const request=store.dispatch(fetchAudit(args));
        if(label==='активная роль'){vi.mocked(bffApi.switchRole).mockResolvedValueOnce(next);await store.dispatch(authSwitchRole(next.user.activeRole));}
        else{vi.mocked(bffApi.me).mockResolvedValueOnce(next);await store.dispatch(authInit());}
        expect(store.getState().audit).toMatchObject({list:[],loadedPage:null,total:0,error:null,loading:false});
        vi.mocked(bffApi.listAudit).mockResolvedValueOnce(page('new'));await store.dispatch(fetchAudit(args));
        old.resolve(page('private-old'));await request;
        expect(store.getState().audit.list).toEqual(page('new').items);
        expect(store.getState().audit.error).toBeNull();
    });
    it('Поздний отказ старого аккаунта не скрывает новый запрос и его результат',async()=>{
        const store=await setup();const old=deferred<ReturnType<typeof page>>();
        vi.mocked(bffApi.listAudit).mockReturnValueOnce(old.promise);const request=store.dispatch(fetchAudit(args));
        vi.mocked(bffApi.me).mockResolvedValueOnce({...owner,user:{...owner.user,id:'two'}});await store.dispatch(authInit());
        const current=deferred<ReturnType<typeof page>>();vi.mocked(bffApi.listAudit).mockReturnValueOnce(current.promise);const refresh=store.dispatch(fetchAudit(args));
        old.reject(denied(403));await request;
        expect(store.getState().audit).toMatchObject({loading:true,error:null,list:[]});
        current.resolve(page('new'));await refresh;expect(store.getState().audit.list).toEqual(page('new').items);
    });
    it('Проверка прежних прав сохраняет кэш и владельца уже выполняемого чтения',async()=>{
        const store=await setup();const pending=deferred<ReturnType<typeof page>>();
        vi.mocked(bffApi.listAudit).mockReturnValueOnce(pending.promise);const request=store.dispatch(fetchAudit(args));
        vi.mocked(bffApi.me).mockResolvedValueOnce({...owner,user:{...owner.user,userRoles:[...owner.user.userRoles].reverse()},policies:{projects:['read'],audit:['read']}});
        await store.dispatch(authInit());expect(store.getState().audit.list).toEqual(page('known').items);
        expect(store.getState().audit.loading).toBe(true);pending.resolve(page('fresh'));await request;
        expect(store.getState().audit.list).toEqual(page('fresh').items);
    });
    it.each([401,403,404])('Текущий HTTP%i убирает старые записи, не выдавая их за допустимый кэш',async status=>{
        const store=await setup();vi.mocked(bffApi.listAudit).mockRejectedValueOnce(denied(status));await store.dispatch(fetchAudit(args));
        expect(store.getState().audit).toMatchObject({list:[],loadedPage:null,total:0,loading:false,error:'Нет доступа'});
    });
    it('Временный сетевой отказ сохраняет записи текущего владельца с явной ошибкой',async()=>{
        const store=await setup();vi.mocked(bffApi.listAudit).mockRejectedValueOnce(new Error('Сеть отключена'));await store.dispatch(fetchAudit(args));
        expect(store.getState().audit.list).toEqual(page('known').items);
        expect(store.getState().audit).toMatchObject({loadedPage:1,loading:false,error:'Сеть отключена'});
    });
    it('Отозванный маршрут не запускает новый HTTP из прежнего обработчика',async()=>{
        const store=await setup();vi.mocked(bffApi.me).mockResolvedValueOnce({...owner,user:{...owner.user,routePermissions:[]}});await store.dispatch(authInit());
        const result=await store.dispatch(fetchAudit(args));
        expect(fetchAudit.rejected.match(result)&&result.meta.condition).toBe(true);expect(bffApi.listAudit).toHaveBeenCalledTimes(1);
        expect(store.getState().audit.list).toEqual([]);
    });
    it('Старый authInit не возвращает кэш после уже выбранной новой роли',async()=>{
        const store=await setup();const initial=deferred<IAuthMe>();vi.mocked(bffApi.me).mockReturnValueOnce(initial.promise);
        const oldAuth=store.dispatch(authInit());const next={...owner,user:{...owner.user,activeRole:'Администратор'}};
        vi.mocked(bffApi.switchRole).mockResolvedValueOnce(next);await store.dispatch(authSwitchRole(next.user.activeRole));
        vi.mocked(bffApi.listAudit).mockResolvedValueOnce(page('new'));await store.dispatch(fetchAudit(args));
        initial.resolve(owner);await oldAuth;
        expect(store.getState().audit.list).toEqual(page('new').items);expect(store.getState().audit.authScope).toContain('Администратор');
    });
    it('Отказ смены роли и выхода сохраняет текущего владельца',async()=>{
        const store=await setup();vi.mocked(bffApi.switchRole).mockRejectedValueOnce(new Error('503'));await store.dispatch(authSwitchRole('Администратор'));
        vi.mocked(bffApi.logout).mockRejectedValueOnce(new Error('503'));await store.dispatch(authLogout());
        expect(store.getState().audit.list).toEqual(page('known').items);expect(store.getState().audit.authRequestId).toBeNull();
    });
    it('Текущий отказ auth очищает журнал и оставшиеся ответы прежнего владельца',async()=>{
        const store=await setup();const pending=deferred<ReturnType<typeof page>>();vi.mocked(bffApi.listAudit).mockReturnValueOnce(pending.promise);
        const request=store.dispatch(fetchAudit(args));vi.mocked(bffApi.me).mockRejectedValueOnce(denied(401));await store.dispatch(authInit());
        pending.resolve(page('private-old'));await request;
        expect(store.getState().audit).toMatchObject({list:[],authScope:null,requestId:null,error:null,loading:false});
    });
});
