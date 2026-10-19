import {createElement,type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import bffApi from '../src/core/api/bff';
import type {IProjectDetail} from '../src/core/api/interfaces';
import MembersTab from '../src/modules/Projects/components/MembersTab';

const hooks=vi.hoisted(()=>{
    let cursor=0;const slots:unknown[]=[];
    return {
        begin:()=>{cursor=0;},reset:()=>{slots.length=0;cursor=0;},
        useState<T>(initial:T|(()=>T)){
            const index=cursor++;if(index>=slots.length)slots[index]=typeof initial==='function'?(initial as ()=>T)():initial;
            return [slots[index],(next:T)=>{slots[index]=next;}];
        },
        useRef<T>(initial:T){const index=cursor++;if(index>=slots.length)slots[index]={current:initial};return slots[index];},
    };
});
const ui=vi.hoisted(()=>({fields:new Map<string,(event:{target:{value:string}})=>void>(),submit:undefined as undefined|(()=>Promise<void>)}));
vi.mock('react',async()=>({...await vi.importActual('react'),useState:hooks.useState,useRef:hooks.useRef,useEffect:()=>undefined}));
vi.mock('react-redux',()=>({useSelector:(select:(state:unknown)=>unknown)=>select({userBlock:{user:{activeRole:'Главный админ',userRoles:['Главный админ']}}})}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner',()=>({useAuthRequestOwner:()=>({captureOwner:()=>()=>true})}));
vi.mock('../src/core/socket/useSectionUpdates',()=>({useSectionUpdates:()=>undefined}));
vi.mock('../src/core/api/bff',()=>({default:{addProjectMember:vi.fn(),listProjectMembers:vi.fn()}}));
vi.mock('antd',()=>{
    const content=({children}:{children?:ReactNode})=>children;
    return {Alert:()=>null,Form:Object.assign(content,{Item:content}),Space:content,Select:()=>null,Table:()=>null,Button:()=>null,
        Input:({id,onChange}:{id:string;onChange:(event:{target:{value:string}})=>void})=>{ui.fields.set(id,onChange);return null;},
        Modal:({onOk,children}:{onOk:()=>Promise<void>;children?:ReactNode})=>{ui.submit=onOk;return children;},
        Typography:{Paragraph:content},message:{success:vi.fn(),error:vi.fn()},
    };
});

const render=()=>{hooks.begin();renderToStaticMarkup(createElement(MembersTab,{project:{id:'prj-test'} as IProjectDetail}));};

beforeEach(()=>{
    vi.clearAllMocks();hooks.reset();ui.fields.clear();ui.submit=undefined;
    vi.mocked(bffApi.listProjectMembers).mockResolvedValue([]);render();
});

describe('Необязательное имя при добавлении сотрудника',()=>{
    it.each(['','   '])('Не подставляет почту вместо пустого имени %j',async name=>{
        ui.fields.get('member-email')!({target:{value:'member@example.test'}});
        ui.fields.get('member-name')!({target:{value:name}});render();
        await ui.submit!();
        expect(bffApi.addProjectMember).toHaveBeenCalledWith('prj-test',{
            principalName:'member@example.test',displayName:undefined,role:'Разработчик',
        });
    });

    it('Сохраняет явно введённое имя для проектного назначения',async()=>{
        ui.fields.get('member-email')!({target:{value:'member@example.test'}});
        ui.fields.get('member-name')!({target:{value:'  Коллега  '}});render();
        await ui.submit!();
        expect(bffApi.addProjectMember).toHaveBeenCalledWith('prj-test',expect.objectContaining({displayName:'Коллега'}));
    });
});
