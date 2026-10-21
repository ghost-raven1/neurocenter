import {createElement,type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {ProjectSnapshots} from '../src/features/ProjectSnapshots/ProjectSnapshots';
import {SnapshotCard} from '../src/features/ProjectSnapshots/SnapshotCard';
import type {ProjectSnapshot} from '../src/features/ProjectSnapshots/types';
interface ButtonProps {children?:ReactNode;disabled?:boolean;href?:string;onClick?:()=>void}
const io=vi.hoisted(()=>({buttons:new Map<string,ButtonProps>(),checkbox:undefined as undefined|((event:{target:{checked:boolean}})=>void),grace:undefined as undefined|((value:number)=>void),dialog:undefined as undefined|{onOk:()=>Promise<void>;content:ReactNode},submit:vi.fn(),refresh:vi.fn(),reload:vi.fn(),choose:vi.fn(),confirmed:vi.fn(),epoch:0,level:'Главный админ',intent:{} as Record<string,unknown>,snapshots:{} as Record<string,unknown>,bridge:{} as Record<string,unknown>}));
vi.mock('react-redux',()=>({useSelector:(select:(state:unknown)=>unknown)=>select({userBlock:{user:{email:'alice@example.test',activeRole:io.level,userRoles:[io.level],projectRoles:[]}}})}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner',()=>({useAuthRequestOwner:()=>({scope:io.level,captureOwner:()=>{const epoch=io.epoch;return()=>io.epoch===epoch;}})}));
vi.mock('../src/features/ProjectSnapshots/useProjectSnapshots',()=>({useProjectSnapshots:()=>io.snapshots}));
vi.mock('../src/features/ProjectSnapshots/useSnapshotIntent',()=>({useSnapshotIntent:()=>io.intent}));
vi.mock('../src/features/McpBridge/useBridge',()=>({useBridge:()=>io.bridge}));
vi.mock('antd',()=>{
    const content=({children}:{children?:ReactNode})=>children;
    return {Space:content,Card:content,Typography:{Text:content,Title:content},Tag:content,Skeleton:()=>null,
        Empty:Object.assign(({description}:{description:ReactNode})=>description,{PRESENTED_IMAGE_SIMPLE:'empty'}),
        Alert:({message,description}:{message?:ReactNode;description?:ReactNode})=>createElement('section',null,message,description),
        Button:(props:ButtonProps)=>{io.buttons.set(String(props.children),props);return createElement('button',{disabled:props.disabled},props.children);},
        Select:()=>null,InputNumber:({onChange}:{onChange:(value:number)=>void})=>{io.grace=onChange;return null;},
        Checkbox:({children,onChange}:{children:ReactNode;onChange:(event:{target:{checked:boolean}})=>void})=>{io.checkbox=onChange;return children;},
        Modal:{confirm:(input:{onOk:()=>Promise<void>;content:ReactNode})=>{io.dialog=input;return{destroy:vi.fn()};}},
    };
});
const sid='11111111-1111-4111-8111-111111111111',did='22222222-2222-4222-8222-222222222222';
const snapshot=(patch:Partial<ProjectSnapshot>={}):ProjectSnapshot=>({snapshotId:sid,storeId:'store',parentId:null,status:'VERIFIED',author:'alice@example.test',createdAt:'2026-10-21T00:00:00Z',bytes:1024,formatVersion:'1',isHead:false,pinned:false,manifestSha256:'b'.repeat(64),error:null,jobId:null,...patch});
function render(){io.buttons.clear();return renderToStaticMarkup(createElement(ProjectSnapshots,{projectId:'project-one',onChanged:io.confirmed}));}
beforeEach(()=>{vi.clearAllMocks();io.epoch++;io.level='Главный админ';io.dialog=undefined;io.checkbox=undefined;io.grace=undefined;
    io.intent={loading:false,busy:false,blocked:false,missing:false,error:'',notice:'',submit:io.submit,refresh:io.refresh,repeat:vi.fn(),abandon:vi.fn()};
    io.snapshots={ready:true,loading:false,error:'',refresh:io.refresh,data:{project:{id:'project-one',head:null,headRevision:7,activeProfileId:null,activeProfileRevision:3},snapshots:[snapshot()],profiles:[],capabilities:{available:true,reason:null,format:'neurocenter.lancedb-snapshot/v1',chunkBytes:1024,maxBytes:4096}}};
    const device={id:did,name:'Computer',role:'Разработчик',online:true,report:{protocolVersion:2,capabilities:['managed-installations','durable-completions','workspace-instance-v1','project-snapshots-v1'],bindings:[{projectId:'project-one',folderName:'folder',valid:true,identityStatus:'verified',bindingId:'a'.repeat(64),instanceId:crypto.randomUUID()}]}};
    io.bridge={device,devices:[device],devicesReady:true,errors:{devices:''},reload:io.reload,choose:io.choose};
});
describe('Snapshot UI true server state and exact guarded commands',()=>{
    it('Creates from the selected current computer and preserves top-level revision even when head is null',()=>{render();expect(io.submit).not.toHaveBeenCalled();expect(io.buttons.get('Создать снимок')?.disabled).toBe(false);io.buttons.get('Создать снимок')!.onClick!();expect(io.submit).toHaveBeenCalledWith({projectId:'project-one',kind:'create',input:{requestKey:expect.any(String),deviceId:did,expectedBindingId:'a'.repeat(64),expectedHeadId:null,expectedHeadRevision:7}});});
    it('Old bridge capability is an explicit update reason, not a silent publish fallback',()=>{(io.bridge.device as {report:{capabilities:string[]}}).report.capabilities.pop();const html=render();expect(io.buttons.get('Создать снимок')?.disabled).toBe(true);expect(html).toContain('Обновите мост');expect(html).toContain('project-snapshots-v1');expect(io.submit).not.toHaveBeenCalled();});
    it.each(['missing-receipt','read-error','pending-publication','server-unavailable','read-only'] as const)('Disables new capture for %s',kind=>{
        if(kind==='missing-receipt')io.intent.intent={projectId:'project-one',kind:'create',input:{requestKey:crypto.randomUUID(),deviceId:did}};
        if(kind==='read-error'){io.snapshots.ready=false;io.snapshots.error='Network error';}
        if(kind==='pending-publication')(io.snapshots.data as {snapshots:ProjectSnapshot[]}).snapshots=[snapshot({status:'VERIFYING'})];
        if(kind==='server-unavailable')(io.snapshots.data as {capabilities:{available:boolean;reason:string}}).capabilities={available:false,reason:'Verifier offline'};
        if(kind==='read-only')io.level='Наблюдатель';render();expect(io.buttons.get('Создать снимок')?.disabled).toBe(true);expect(io.submit).not.toHaveBeenCalled();
    });
    it('Release confirmation can atomically move head with exact profile and head CAS; no unversioned skill list',async()=>{
        render();io.buttons.get('Выпустить профиль')!.onClick!();expect(io.submit).not.toHaveBeenCalled();expect(io.dialog).toBeDefined();renderToStaticMarkup(createElement('div',null,io.dialog!.content));io.checkbox!({target:{checked:true}});await io.dialog!.onOk();
        expect(io.submit).toHaveBeenCalledWith({projectId:'project-one',kind:'release',input:{requestKey:expect.any(String),snapshotId:sid,expectedProfileId:null,expectedProfileRevision:3,moveHead:{expectedHeadId:null,expectedHeadRevision:7}}});
    });
    it('Delete requires explicit confirmation and sends retained manifest/grace; owner withdrawal defeats an open dialog',async()=>{
        render();io.buttons.get('Удалить')!.onClick!();expect(io.submit).not.toHaveBeenCalled();renderToStaticMarkup(createElement('div',null,io.dialog!.content));io.grace!(48);await io.dialog!.onOk();expect(io.submit).toHaveBeenCalledWith({projectId:'project-one',kind:'delete',snapshotId:sid,input:{requestKey:expect.any(String),expectedManifest:'b'.repeat(64),gracePeriodHours:48}});
        io.submit.mockClear();io.epoch++;await io.dialog!.onOk();expect(io.submit).not.toHaveBeenCalled();
    });
    it('Verified server head is protected from removal and never claims local OpenCode switched',()=>{
        io.buttons.clear();const html=renderToStaticMarkup(createElement(SnapshotCard,{projectId:'p',snapshot:snapshot({isHead:true}),blocked:false,canWrite:true,hasHead:true,onAction:vi.fn()}));expect(io.buttons.has('Удалить')).toBe(false);expect(io.buttons.has('Сделать текущим')).toBe(false);expect(html).toContain('Текущий на сервере');expect(html).toContain('Локальная сессия OpenCode не переключается');
    });
    it('Failed/pending/deleting states do not offer activation or falsely claim verified readiness',()=>{
        for(const status of ['REJECTED','UPLOADING','VERIFYING','DELETING','DELETED'] as const){io.buttons.clear();renderToStaticMarkup(createElement(SnapshotCard,{projectId:'p',snapshot:snapshot({status}),blocked:false,canWrite:true,hasHead:true,onAction:vi.fn()}));expect(io.buttons.has('Сделать текущим')).toBe(false);expect(io.buttons.has('Выпустить профиль')).toBe(false);expect(io.buttons.has('Отменить публикацию')).toBe(status==='UPLOADING'||status==='VERIFYING');}
    });
});
