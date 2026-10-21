import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe,expect,it,vi} from 'vitest';
import type {IOperation} from '../src/core/api/interfaces';
import type {IUserInfo} from '../src/core/interfaces';
import {operationActionPermissions} from '../src/modules/Operations/operationActions';
import OperationActionButtons from '../src/modules/Operations/OperationActionButtons';

const user={email:'owner@example.test',activeRole:'Админ проекта',userRoles:['Админ проекта'],projectRoles:[{projectId:'prj-own',projectName:'Own',role:'Админ проекта'}]} as IUserInfo;
const operation={operationId:'rag-reindex-plan',resourceType:'rag-reindex',resourceId:'plan',projectId:'prj-own',actor:user.email,state:'FAILED',
    actions:{executor:'rag-reindex',digest:'a'.repeat(64),retry:{supported:true},cancel:{supported:false,reason:'Поколение уже завершено.'}}} as unknown as IOperation;
describe('Journal actions follow real executor capabilities',()=>{
    it('Offers retry for an owned failed RAG plan and blocks stale owner or project permissions',()=>{
        expect(operationActionPermissions(operation,user).retry).toBe(true);
        expect(operationActionPermissions(operation,{...user,email:'other@example.test'}).retry).toBe(false);
        expect(operationActionPermissions(operation,{...user,projectRoles:[]}).retry).toBe(false);
        expect(operationActionPermissions({...operation,actions:undefined} as IOperation,user).retry).toBe(false);
    });
    it('Renders disabled historical actions with the executor reason instead of pretending journal state is executable',()=>{
        const historical={...operation,resourceType:'project',actions:{executor:'history',digest:'b'.repeat(64),retry:{supported:false,reason:'Историческая запись не содержит исполняемого задания.'},cancel:{supported:false,reason:'Историческая запись уже завершена.'}}} as unknown as IOperation;
        const html=renderToStaticMarkup(createElement(OperationActionButtons,{operation:historical,user,actions:{isBusy:()=>false,retry:vi.fn(),cancel:vi.fn()}}));
        expect(html).toContain('Историческая запись не содержит исполняемого задания.');
        expect(html).toMatch(/disabled=""[^>]*>[^<]*<span>Повторить/);
    });
});
