import {configureStore} from '@reduxjs/toolkit';
import {afterEach,describe,expect,it,vi} from 'vitest';
import bffApi from '../src/core/api/bff';
import type {IAuthMe} from '../src/core/interfaces';
import {authInit,authLogout,authSwitchRole} from '../src/features/UserBlock/redux/actions';
import userBlock,{signOut} from '../src/features/UserBlock/redux/reducers';
import {fetchDecisions} from '../src/modules/Access/redux/actions';
import access from '../src/modules/Access/redux/reducers';

const auth:IAuthMe={user:{id:'admin',email:'admin@example.test',principalName:'admin',displayName:'Администратор',activeRole:'Главный админ',
    userRoles:['Главный админ','Наблюдатель'],routePermissions:['access'],projectRoles:[]},policies:{access:['read','write']}};
const decisions={decisions:[{scope:'platform',scopeId:'all',actions:['platform.admin'],decisionId:'admin-decision',policyRevision:1,ttlSeconds:0}],externalServiceUrl:null};
const observer:IAuthMe={user:{...auth.user,activeRole:'Наблюдатель',userRoles:['Наблюдатель']},policies:{access:['read']}};
function createStore(){
    const store=configureStore({reducer:{access,userBlock}});
    store.dispatch(authInit.pending('initial',undefined));store.dispatch(authInit.fulfilled(auth,'initial',undefined));return store;
}
function loaded(){const store=createStore();store.dispatch(fetchDecisions.pending('read','project'));store.dispatch(fetchDecisions.fulfilled(decisions,'read','project'));return store;}
afterEach(()=>vi.restoreAllMocks());

describe('Владелец фактических прав доступа',()=>{
    it('Выход сразу очищает прежние решения и ссылку сервиса',()=>{
        const store=loaded();expect(store.getState().access.decisions).toHaveLength(1);
        store.dispatch(signOut());expect(store.getState().access).toMatchObject({decisions:[],externalServiceUrl:null,loading:false,currentRequestId:null});
    });
    it.each(['success','error'])('Поздний HTTP %s после выхода не возвращает прежние права или ошибку',async mode=>{
        const store=createStore();let resolve!:(value:typeof decisions)=>void,reject!:(error:Error)=>void;
        vi.spyOn(bffApi,'getDecisions').mockReturnValue(new Promise((yes,no)=>{resolve=yes;reject=no;}));
        const pending=store.dispatch(fetchDecisions('project'));store.dispatch(signOut());
        if(mode==='success')resolve(decisions);else reject(new Error('Старая ошибка'));
        await pending;expect(store.getState().access).toMatchObject({decisions:[],error:'',loading:false,currentRequestId:null});
    });
    it('Смена роли очищает решения и игнорирует прежний ответ без нового GET',()=>{
        const store=loaded();store.dispatch(fetchDecisions.pending('old','project'));
        store.dispatch(authSwitchRole.pending('role','Наблюдатель'));store.dispatch(authSwitchRole.fulfilled(observer,'role','Наблюдатель'));
        store.dispatch(fetchDecisions.fulfilled(decisions,'old','project'));
        expect(store.getState().access).toMatchObject({decisions:[],loading:false,currentRequestId:null});
        store.dispatch(fetchDecisions.pending('new','project'));store.dispatch(fetchDecisions.fulfilled({decisions:[],externalServiceUrl:null},'new','project'));
        expect(store.getState().access).toMatchObject({decisions:[],loading:false,error:''});
    });
    it('Обычная проверка той же сессии сохраняет загруженные решения',()=>{
        const store=loaded();store.dispatch(authInit.pending('refresh',undefined));store.dispatch(authInit.fulfilled(auth,'refresh',undefined));
        expect(store.getState().access.decisions).toEqual(decisions.decisions);
    });
    it('Изменение назначений при прежней активной роли инвалидирует данные',()=>{
        const store=loaded();store.dispatch(authInit.pending('refresh',undefined));
        store.dispatch(authInit.fulfilled({...auth,user:{...auth.user,projectRoles:[{projectId:'prj-one',projectName:'Первый',role:'Наблюдатель'}]}},'refresh',undefined));
        expect(store.getState().access.decisions).toEqual([]);
    });
    it('Отказ актуальной авторизации очищает данные, старый отказ не очищает новую сессию',()=>{
        const store=loaded();store.dispatch(authInit.pending('old-auth',undefined));store.dispatch(authInit.pending('new-auth',undefined));
        store.dispatch(authInit.fulfilled(auth,'new-auth',undefined));store.dispatch(authInit.rejected(null,'old-auth',undefined,'unauthorized'));
        expect(store.getState().access.decisions).toHaveLength(1);
        store.dispatch(authInit.pending('failed-auth',undefined));store.dispatch(authInit.rejected(null,'failed-auth',undefined,'unauthorized'));
        expect(store.getState().access.decisions).toEqual([]);
    });
    it.each(['logout','switch'])('Отказ %s с unauthorized очищает сведения',kind=>{
        const store=loaded();
        if(kind==='logout'){store.dispatch(authLogout.pending('out',undefined));store.dispatch(authLogout.rejected(null,'out',undefined,'unauthorized'));}
        else{store.dispatch(authSwitchRole.pending('role','Наблюдатель'));store.dispatch(authSwitchRole.rejected(null,'role','Наблюдатель','unauthorized'));}
        expect(store.getState().access.decisions).toEqual([]);
    });
    it('Чтение без авторизации не получает владельца для позднего ответа',()=>{
        const store=configureStore({reducer:{access,userBlock}});store.dispatch(fetchDecisions.pending('anonymous','project'));
        store.dispatch(fetchDecisions.fulfilled(decisions,'anonymous','project'));expect(store.getState().access.decisions).toEqual([]);
    });
});
