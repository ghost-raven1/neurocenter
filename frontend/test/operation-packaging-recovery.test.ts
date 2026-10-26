import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe,expect,it,vi} from 'vitest';
import type {IOperation} from '../src/core/api/interfaces';
import type {IUserInfo} from '../src/core/interfaces';
import OperationActionButtons from '../src/modules/Operations/OperationActionButtons';

const user = {email:'admin@example.test',activeRole:'Главный админ',userRoles:['Главный админ'],projectRoles:[]} as IUserInfo;
const operation = {operationId:'build-failed',type:'BUILD',resourceType:'tool-build',resourceId:'build',actor:user.email,
    projectId:'prj-example',state:'FAILED',actions:{executor:'tool-build',digest:'a'.repeat(64),
        retry:{supported:false,reason:'Откройте упаковщик и создайте новый запрос с проверенным источником.'},
        cancel:{supported:false}}} as IOperation;
const actions = {isBusy:()=>false,retry:vi.fn(),cancel:vi.fn()};
const render = (change:Partial<IOperation> = {},currentUser:IUserInfo|null = user) =>
    renderToStaticMarkup(createElement(OperationActionButtons,{operation:{...operation,...change},user:currentUser,actions}));

describe('Восстановление после неудачной упаковки из журнала',()=>{
    it('Открывает упаковщик выбранного проекта без повтора неудачной сборки',()=>{
        const html = render();
        expect(html).toContain('Открыть упаковщик');
        expect(html).toContain('href="/store?packaging=open&amp;p=prj-example"');
        expect(html).toMatch(/disabled=""[^>]*><span>Повторить<\/span>/);
        expect(actions.retry).not.toHaveBeenCalled();
    });
    it('Сохраняет выход для отменённой общей сборки',()=>{
        expect(render({state:'CANCELLED',projectId:null})).toContain('href="/store?packaging=open"');
    });
    it.each(['QUEUED','RUNNING','SUCCEEDED'] as const)('Не предлагает восстановление состояния %s',state=>{
        expect(render({state})).not.toContain('Открыть упаковщик');
    });
    it.each([null,{...user,userRoles:[]},{...user,activeRole:'Разработчик',userRoles:['Главный админ','Разработчик']}])('Проверяет текущую роль перед переходом',currentUser=>{
        expect(render({},currentUser)).not.toContain('Открыть упаковщик');
    });
    it('Не приписывает упаковку другой операции и не переносит непроверенный проект',()=>{
        expect(render({resourceType:'project'})).not.toContain('Открыть упаковщик');
        expect(render({projectId:'../project?tab=rag'})).not.toContain('Открыть упаковщик');
    });
});
