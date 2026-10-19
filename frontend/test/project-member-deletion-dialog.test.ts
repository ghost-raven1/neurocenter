import {createElement,type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {message} from 'antd';
import bffApi from '../src/core/api/bff';
import type {IProjectDetail,IProjectMember} from '../src/core/api/interfaces';
import MembersTab from '../src/modules/Projects/components/MembersTab';

const ui=vi.hoisted(()=>({
    current:true,remove:undefined as (()=>void)|undefined,
    confirmation:undefined as {onOk:()=>Promise<void>}|undefined,
}));
const member={userId:'user-a',principalName:'member@example.test',role:'Разработчик'} as IProjectMember;
vi.mock('react-redux',()=>({useSelector:(select:(state:unknown)=>unknown)=>select({userBlock:{user:{activeRole:'Главный админ',userRoles:['Главный админ']}}})}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner',()=>({useAuthRequestOwner:()=>({captureOwner:()=>()=>ui.current})}));
vi.mock('../src/core/socket/useSectionUpdates',()=>({useSectionUpdates:()=>undefined}));
vi.mock('../src/core/api/bff',()=>({default:{removeProjectMember:vi.fn()}}));
vi.mock('antd',()=>{
    const content=({children}:{children?:ReactNode})=>children;
    return {Alert:()=>null,Form:Object.assign(content,{Item:content}),Input:()=>null,Select:()=>null,Space:content,Typography:{Paragraph:content},
        Button:({children,onClick}:{children?:ReactNode;onClick?:()=>void})=>{if(children==='Удалить')ui.remove=onClick;return null;},
        Table:({columns}:{columns:Array<{key?:string;render?:(_:unknown,item:IProjectMember)=>ReactNode}>})=>columns.find(column=>column.key==='actions')?.render?.(undefined,member),
        Modal:Object.assign(()=>null,{confirm:(options:typeof ui.confirmation)=>{ui.confirmation=options;return {destroy:vi.fn()};}}),
        message:{success:vi.fn(),error:vi.fn()},
    };
});

beforeEach(()=>{
    vi.clearAllMocks();ui.current=true;ui.remove=undefined;ui.confirmation=undefined;
    vi.mocked(bffApi.removeProjectMember).mockResolvedValue(undefined);
    renderToStaticMarkup(createElement(MembersTab,{project:{id:'prj-a'} as IProjectDetail}));
    ui.remove!();
});

describe('Подтверждение удаления сотрудника проекта',()=>{
    it('Отказ сохраняет диалог для повторного удаления вместо молчаливого закрытия',async()=>{
        const failure={response:{data:{message:'Роль сотрудника уже изменилась. Обновите список.'}}};
        vi.mocked(bffApi.removeProjectMember).mockRejectedValueOnce(failure);
        await expect(ui.confirmation!.onOk()).rejects.toBe(failure);
        expect(message.error).toHaveBeenCalledExactlyOnceWith(failure.response.data.message);
        expect(message.success).not.toHaveBeenCalled();
        await ui.confirmation!.onOk();
        expect(bffApi.removeProjectMember).toHaveBeenCalledTimes(2);
        expect(message.success).toHaveBeenCalledExactlyOnceWith('Сотрудник удалён');
    });

    it('Повторное подтверждение до ответа не отправляет второе удаление',async()=>{
        let resolve!:(value:void)=>void;
        vi.mocked(bffApi.removeProjectMember).mockReturnValueOnce(new Promise(done=>{resolve=done;}));
        const pending=ui.confirmation!.onOk();await ui.confirmation!.onOk();
        expect(bffApi.removeProjectMember).toHaveBeenCalledOnce();
        resolve();await pending;
        expect(message.success).toHaveBeenCalledOnce();
    });

    it('Поздний отказ прежней сессии не уведомляет новую и не удерживает диалог',async()=>{
        let reject!:(cause:unknown)=>void;
        vi.mocked(bffApi.removeProjectMember).mockReturnValueOnce(new Promise((_done,fail)=>{reject=fail;}));
        const pending=ui.confirmation!.onOk();ui.current=false;reject(new Error('Поздний отказ'));
        await pending;
        expect(message.error).not.toHaveBeenCalled();expect(message.success).not.toHaveBeenCalled();
    });
});
