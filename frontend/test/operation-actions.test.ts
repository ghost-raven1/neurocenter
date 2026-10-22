import {describe,expect,it} from 'vitest';
import {operationActions, operationActionPermissions} from '../src/modules/Operations/operationActions';
import type {IOperation} from '../src/core/api/interfaces';
import type {IUserInfo} from '../src/core/interfaces';

const operation={resourceType:'bridge',resourceId:'12345678-1234-1234-1234-123456789abc',actor:'owner@example.test',state:'QUEUED',
    bridgeJob:{kind:'install',retrySupported:true,minimumLevel:2},actions:{executor:'bridge',digest:'a'.repeat(64),retry:{supported:true},cancel:{supported:true}}} as IOperation;
describe('Управление реальной очередью MCP из журнала',()=>{
    it('Позволяет отменить только ещё не начатое личное задание',()=>{expect(operationActions(operation,operation.actor,true)).toEqual({cancel:true,retry:false,reopenKnowledge:false});expect(operationActions({...operation,state:'RUNNING'},operation.actor,true)).toEqual({cancel:false,retry:false,reopenKnowledge:false});});
    it.each(['FAILED','CANCELLED'])('Повтор доступен для состояния %s при наличии права записи',state=>{expect(operationActions({...operation,state} as IOperation,operation.actor,true).retry).toBe(true);expect(operationActions({...operation,state} as IOperation,operation.actor,false).retry).toBe(false);});
    it.each(['SUCCEEDED','RUNNING','QUEUED'])('Не выдаёт повтор состояния %s за запуск работы',state=>{expect(operationActions({...operation,state} as IOperation,operation.actor,true).retry).toBe(false);});
    it('Не предлагает менять чужое задание и обычную запись истории',()=>{expect(operationActions(operation,'other@example.test',true).cancel).toBe(false);expect(operationActions({...operation,resourceType:'quota'},operation.actor,true).cancel).toBe(false);});
    it('Не принимает пустого владельца и некорректный идентификатор задания',()=>{
        expect(operationActions({...operation,actor:''},'',true).cancel).toBe(false);
        expect(operationActions({...operation,resourceId:'-'.repeat(36)},operation.actor,true).cancel).toBe(false);
    });
    it('Наблюдатель может отменить личную очередь, но не повторять запись в проекте',()=>{
        const observer = {
            email:operation.actor,activeRole:'Наблюдатель',userRoles:['Наблюдатель'],
            projectRoles:[{projectId:'project',projectName:'project',role:'Наблюдатель'}],
        } as IUserInfo;
        expect(operationActionPermissions({...operation,projectId:'project'},observer)).toEqual({cancel:true,retry:false,reopenKnowledge:false});
        expect(operationActionPermissions({...operation,projectId:'project',state:'FAILED'},observer).retry).toBe(false);
        expect(operationActionPermissions(operation,{...observer,userRoles:[]})).toEqual({cancel:false,retry:false,reopenKnowledge:false});
    });
    it('Наблюдатель может повторить разрешённую проверку своей установки',()=>{
        const observer={email:operation.actor,activeRole:'Наблюдатель',userRoles:['Наблюдатель'],
            projectRoles:[{projectId:'prj-own',projectName:'Свой',role:'Наблюдатель'}]} as IUserInfo;
        expect(operationActionPermissions({...operation,projectId:'prj-own',state:'FAILED',bridgeJob:{kind:'inspect-installation',retrySupported:true,minimumLevel:1}},observer).retry).toBe(true);
        expect(operationActionPermissions({...operation,projectId:'prj-own',bridgeJob:{kind:'inspect-installation',retrySupported:true,minimumLevel:1}},observer).cancel).toBe(true);
        expect(operationActionPermissions({...operation,projectId:'prj-own',state:'FAILED',bridgeJob:{kind:'inspect-installation',retrySupported:true,minimumLevel:1}},
            {...observer,projectRoles:[]}).retry).toBe(false);
    });
    it.each(['bind-project','probe-runtime','open-rag-ui','apply-local-change'])('Не предлагает запрещённый повтор %s даже разработчику',kind=>{
        expect(operationActions({...operation,state:'FAILED',bridgeJob:{kind,retrySupported:false,minimumLevel:2}},operation.actor,true).retry).toBe(false);
    });
    it('Без подтверждённого исходного задания повтор скрыт, отмена очереди сохраняется',()=>{
        expect(operationActions({...operation,state:'FAILED',bridgeJob:undefined},operation.actor,true).retry).toBe(false);
        expect(operationActions({...operation,bridgeJob:undefined},operation.actor,true).cancel).toBe(true);
    });
    it('Выбор корневой папки остаётся доступен владельцу без назначения проекта',()=>{
        const observer={email:operation.actor,activeRole:'Наблюдатель',userRoles:['Наблюдатель'],projectRoles:[]} as IUserInfo;
        expect(operationActionPermissions({...operation,projectId:null,state:'FAILED',bridgeJob:{kind:'choose-root',retrySupported:true,minimumLevel:2}},observer).retry).toBe(true);
    });
    it('Отзыв доступа к проекту блокирует отмену уже загруженной очереди',()=>{
        const revoked={email:operation.actor,activeRole:'Наблюдатель',userRoles:['Наблюдатель'],projectRoles:[]} as IUserInfo;
        expect(operationActionPermissions({...operation,projectId:'prj-own',bridgeJob:undefined},revoked)).toEqual({cancel:false,retry:false,reopenKnowledge:false});
    });
    it.each([0,3,NaN])('Неподдерживаемый уровень %s не разрешает повтор',minimumLevel=>{
        const admin={email:operation.actor,activeRole:'Главный админ',userRoles:['Главный админ'],projectRoles:[]} as IUserInfo;
        expect(operationActionPermissions({...operation,state:'FAILED',bridgeJob:{kind:'install',retrySupported:true,minimumLevel}},admin).retry).toBe(false);
    });
});

describe('Отмена упаковки из общей истории операций',()=>{
    const main={email:operation.actor,activeRole:'Главный админ',userRoles:['Главный админ'],projectRoles:[]} as IUserInfo;
    const build={...operation,resourceType:'tool-build',state:'RUNNING',projectId:null,
        actions:{executor:'tool-build',digest:'a'.repeat(64),retry:{supported:false},cancel:{supported:true}}} as IOperation;
    it.each(['QUEUED','RUNNING'])('Предлагает владельцу с текущей главной ролью отмену реальной сборки %s',state=>{
        expect(operationActionPermissions({...build,state} as IOperation,main)).toEqual({cancel:true,retry:false,reopenKnowledge:false});
    });
    it('Требует явного права главного админа даже при разрешении записи',()=>{
        expect(operationActions(build,main.email,true).cancel).toBe(false);
        expect(operationActions(build,main.email,false,false,true).cancel).toBe(true);
        expect(operationActionPermissions(build,{...main,activeRole:'Разработчик',userRoles:['Главный админ','Разработчик']}).cancel).toBe(false);
        expect(operationActionPermissions(build,{...main,userRoles:[]}).cancel).toBe(false);
        expect(operationActionPermissions(build,{...main,email:'other@operations.fixture'}).cancel).toBe(false);
    });
    it('Скрывает отмену при серверном запрете публикации и для исторического ID',()=>{
        expect(operationActionPermissions({...build,actions:{...build.actions!,cancel:{supported:false,reason:'Публикация началась.'}}},main).cancel).toBe(false);
        expect(operationActionPermissions({...build,resourceId:'old-build'},main).cancel).toBe(false);
        expect(operationActionPermissions({...build,resourceType:'bridge'},main).cancel).toBe(false);
    });
    it.each(['CANCELLED','FAILED','SUCCEEDED'])('Не выдаёт завершённую сборку %s за отменяемую при устаревших capabilities',state=>{
        expect(operationActionPermissions({...build,state} as IOperation,main).cancel).toBe(false);
    });
    it('Повтор упаковки идёт через новый проверенный источник, даже если capabilities устарели',()=>{
        expect(operationActionPermissions({...build,actions:{...build.actions!,retry:{supported:true}}},main).retry).toBe(false);
    });
});
