import {createElement,type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import RetiredRagDatabases from '../src/features/RetiredRagDatabases/RetiredRagDatabases';
import {PurgePreview} from '../src/features/RetiredRagDatabases/PurgePreview';

const ui=vi.hoisted(()=>({role:'Главный админ',state:{} as any,modal:{} as any,input:undefined as any,value:'',buttons:[] as any[]}));
vi.mock('react',async original=>({...await original<typeof import('react')>(),useState:()=>[ui.value,(value:string)=>{ui.value=value;}],useEffect:()=>{}}));
vi.mock('react-redux',()=>({useSelector:()=>({user:{id:'own',email:'own@example.test',activeRole:ui.role,userRoles:[ui.role],routePermissions:[],projectRoles:[]},policies:{}})}));
vi.mock('../src/features/RetiredRagDatabases/useRetiredRagDatabases',()=>({useRetiredRagDatabases:()=>ui.state}));
vi.mock('antd',()=>{
    const content=({children}:{children?:ReactNode})=>children;
    return{Typography:{Paragraph:content,Text:content},Space:content,Tag:content,Card:({title,children,extra}:any)=>createElement('section',null,title,extra,children),
        Alert:({message,description}:any)=>createElement('aside',null,message,description),Empty:({description}:any)=>description,
        List:Object.assign(({dataSource,renderItem}:any)=>dataSource.map(renderItem),{Item:content}),
        Button:(props:any)=>{ui.buttons.push(props);return createElement('button',{disabled:props.disabled},props.children);},
        Descriptions:Object.assign(content,{Item:content}),Input:(props:any)=>{ui.input=props;return createElement('input',{'aria-label':props['aria-label'],value:props.value,readOnly:true});},
        Modal:(props:any)=>{ui.modal=props;return props.open?props.children:null;}};
});
const row={id:'own-retirement',projectId:'prj-own',projectName:'Проект проверки',deletedAt:'2026-10-21T00:00:00Z',retention:{revision:1,retainUntil:null,reason:'',automaticPurge:false},database:{databaseName:'nc_rag_'+'a'.repeat(32),state:'retained',present:true,bytes:2048},blockers:[],job:null};
const plan={id:'own-preview',digest:'a'.repeat(64),expiresAt:'2099-01-01T00:00:00Z',projectName:row.projectName,retentionRevision:1,warning:'Резервные копии и полные снимки сохраняются.',facts:{identity:{databaseName:row.database.databaseName,cluster:'123',oid:'456',marker:'own-marker',projectId:row.projectId},bytes:2048,chunks:3,generations:2}} as any;
beforeEach(()=>{ui.role='Главный админ';ui.value='';ui.buttons=[];ui.state={items:[row],loading:false,busy:false,error:null,preview:null,selected:null,refresh:vi.fn(),open:vi.fn(),close:vi.fn(),purge:vi.fn(),retry:vi.fn(),retention:vi.fn()};});
describe('Retained databases: explicit destructive review and truthful states',()=>{
    it('Only mainadmin sees physical retained databases and management actions',()=>{expect(renderToStaticMarkup(createElement(RetiredRagDatabases))).toContain(row.database.databaseName);ui.role='Админ проекта';expect(renderToStaticMarkup(createElement(RetiredRagDatabases))).toBe('');});
    it('Discovery timestamp is shown as an accounting date rather than an invented deletion date',()=>{const html=renderToStaticMarkup(createElement(RetiredRagDatabases));expect(html).toContain('учтена с');expect(html).not.toContain('проект удалён');});
    it('Active jobs, holds and missing DBs disable purge rather than presenting a false ready action',()=>{
        for(const changes of [{blockers:['Индексация ещё выполняется']},{database:null},{job:{state:'running',message:'Ожидает сверки'}}]){ui.buttons=[];ui.state.items=[{...row,...changes}];renderToStaticMarkup(createElement(RetiredRagDatabases));expect(ui.buttons.find(button=>button.children==='Проверить и удалить')?.disabled).toBe(true);}
    });
    it('Completed receipt with a newly present physical DB is an anomaly and cannot delete the replacement',()=>{ui.state.items=[{...row,database:{...row.database,state:'purged'},job:{state:'succeeded',message:'Предыдущее удаление подтверждено'}}];const html=renderToStaticMarkup(createElement(RetiredRagDatabases));expect(html).toContain('После подтверждённого удаления появилась новая физическая база');expect(ui.buttons.find(button=>button.children==='Проверить и удалить')?.disabled).toBe(true);});
    it('Preview shows exact physical identity/bytes/impact/digest and requires exact typed project name',()=>{
        const props={plan,busy:false,onClose:vi.fn(),onPurge:vi.fn()},html=renderToStaticMarkup(createElement(PurgePreview,props));expect(html).toContain(plan.digest);expect(html).toContain(row.database.databaseName);expect(html).toContain('3 фрагментов');expect(html).toContain('Резервные копии и полные снимки сохраняются');expect(ui.modal.okButtonProps.disabled).toBe(true);
        ui.input.onChange({target:{value:row.projectName}});renderToStaticMarkup(createElement(PurgePreview,props));expect(ui.modal.okButtonProps.disabled).toBe(false);expect(ui.modal.okButtonProps.danger).toBe(true);
    });
    it('Expired plan and running execution cannot be confirmed or dismissed accidentally',()=>{ui.value=row.projectName;renderToStaticMarkup(createElement(PurgePreview,{plan:{...plan,expiresAt:'2020-01-01T00:00:00Z'},busy:true,onClose:vi.fn(),onPurge:vi.fn()}));expect(ui.modal.okButtonProps.disabled).toBe(true);expect(ui.modal.maskClosable).toBe(false);expect(ui.modal.cancelButtonProps.disabled).toBe(true);});
});
