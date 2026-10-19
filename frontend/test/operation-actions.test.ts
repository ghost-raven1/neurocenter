import {describe,expect,it} from 'vitest';
import {operationActions, operationActionPermissions} from '../src/modules/Operations/operationActions';
import type {IOperation} from '../src/core/api/interfaces';
import type {IUserInfo} from '../src/core/interfaces';

const operation={resourceType:'bridge',resourceId:'12345678-1234-1234-1234-123456789abc',actor:'owner@example.test',state:'QUEUED'} as IOperation;
describe('Управление реальной очередью MCP из журнала',()=>{
    it('Позволяет отменить только ещё не начатое личное задание',()=>{expect(operationActions(operation,operation.actor,true)).toEqual({cancel:true,retry:false});expect(operationActions({...operation,state:'RUNNING'},operation.actor,true)).toEqual({cancel:false,retry:false});});
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
        expect(operationActionPermissions({...operation,projectId:'project'},observer)).toEqual({cancel:true,retry:false});
        expect(operationActionPermissions({...operation,projectId:'project',state:'FAILED'},observer).retry).toBe(false);
        expect(operationActionPermissions(operation,{...observer,userRoles:[]})).toEqual({cancel:false,retry:false});
    });
});
