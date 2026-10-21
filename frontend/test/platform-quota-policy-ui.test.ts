import {createElement,type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {RagQuotaPolicy} from '../src/features/RagQuotaPolicy/RagQuotaPolicy';
import base from '../src/core/api/base';
const ui=vi.hoisted(()=>({cursor:0,refCursor:0,effectCursor:0,states:[] as unknown[],refs:[] as unknown[],effects:[] as Array<{deps:unknown[];cleanup?:()=>void}>,pending:[] as Array<()=>void>,
 owner:'main',role:'Главный админ',roles:['Главный админ'],user:true,buttons:new Map<string,any>(),fields:new Map<string,any>(),values:{} as Record<string,number>,formProps:undefined as any,refresh:undefined as (()=>void)|undefined}));
const owner=vi.hoisted(()=>({captureOwner:()=>()=>ui.owner==='main'}));
vi.mock('react',async original=>({...await original<typeof import('react')>(),
 useState:(initial:unknown)=>{const index=ui.cursor++;if(!(index in ui.states))ui.states[index]=typeof initial==='function'?(initial as ()=>unknown)():initial;return[ui.states[index],(value:unknown)=>{ui.states[index]=typeof value==='function'?(value as (old:unknown)=>unknown)(ui.states[index]):value;}];},
 useRef:(initial:unknown)=>{const index=ui.refCursor++;return ui.refs[index]??={current:initial};},
 useEffect:(effect:()=>void|(()=>void),deps:unknown[])=>{const index=ui.effectCursor++,old=ui.effects[index];if(!old||deps.some((dep,i)=>!Object.is(dep,old.deps[i])))ui.pending.push(()=>{old?.cleanup?.();ui.effects[index]={deps,cleanup:effect()||undefined};});},
}));
vi.mock('react-redux',()=>({useSelector:(select:any)=>select({userBlock:{user:ui.user?{email:'main@example.test',activeRole:ui.role,userRoles:ui.roles}:null,policies:{}}})}));
vi.mock('../src/features/UserBlock/authDataScope',()=>({authDataScope:()=>ui.owner}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner',()=>({useAuthRequestOwner:()=>owner}));
vi.mock('../src/core/socket/useSectionUpdates',()=>({useSectionUpdates:(_sections:unknown,callback:()=>void)=>{ui.refresh=callback;}}));
vi.mock('../src/core/api/base',()=>({default:{get:vi.fn(),patch:vi.fn()}}));
vi.mock('antd',()=>{
 const content=({children}: {children?:ReactNode})=>children;
 const Form=Object.assign((props:any)=>{ui.formProps=props;return props.children;},{useForm:()=>[{setFieldsValue:(value:Record<string,number>)=>Object.assign(ui.values,value),getFieldValue:(name:string)=>ui.values[name]}],
  Item:(props:any)=>{ui.fields.set(props.name,props);return props.children;}});
 return {Form,Space:content,Typography:{Paragraph:content},Card:({children,title,extra}:any)=>createElement('section',null,title,extra,children),Spin:()=>createElement('span',null,'loading'),InputNumber:()=>null,
  Alert:({message,description}:any)=>createElement('div',null,message,description),Button:(props:any)=>{ui.buttons.set(props.children,props);return props.children;}};
});
const policy=(patch={})=>({defaultBytes:1024**3,maximumBytes:16*1024**3,revision:0,updatedAt:'2026-10-22T00:00:00.000Z',updatedBy:'main@example.test',...patch});
const flush=async()=>{for(let i=0;i<24;i++)await Promise.resolve();};
function render(){ui.cursor=0;ui.refCursor=0;ui.effectCursor=0;ui.buttons.clear();ui.fields.clear();const html=renderToStaticMarkup(createElement(RagQuotaPolicy));const effects=ui.pending.splice(0);effects.forEach(effect=>effect());return html;}
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};}
async function load(){render();await flush();return render();}
function edit(defaultMiB=2048,maximumMiB=65536){Object.assign(ui.values,{defaultMiB,maximumMiB});ui.formProps.onValuesChange();render();}
beforeEach(()=>{vi.clearAllMocks();Object.assign(ui,{cursor:0,refCursor:0,effectCursor:0,states:[],refs:[],effects:[],pending:[],owner:'main',role:'Главный админ',roles:['Главный админ'],user:true,values:{},formProps:undefined,refresh:undefined});vi.mocked(base.get).mockResolvedValue({data:policy()});});
describe('Admin platform quota UI actions and races',()=>{
 it.each([{user:false},{role:'Разработчик'},{roles:['Разработчик']}])('does not read or expose settings without the current main-admin role %j',async state=>{Object.assign(ui,state);expect(render()).toBe('');expect(base.get).not.toHaveBeenCalled();});
 it('loads exact MiB values with cancellation and a finite timeout',async()=>{
  expect(await load()).toContain('Квоты баз знаний');expect(ui.values).toEqual({defaultMiB:1024,maximumMiB:16384});expect(ui.buttons.get('Сохранить настройки квот').disabled).toBe(true);
  expect(base.get).toHaveBeenCalledWith('/api/maintenance/rag-quota-policy',expect.objectContaining({timeout:15000,signal:expect.any(AbortSignal)}));
 });
 it('a reconnect updates the policy without replacing a dirty draft or silently adopting a newer revision',async()=>{
  await load();edit();vi.mocked(base.get).mockResolvedValueOnce({data:policy({revision:1,maximumBytes:32*1024**3})});ui.refresh!();await flush();render();expect(ui.values.maximumMiB).toBe(65536);
  vi.mocked(base.patch).mockRejectedValueOnce(Error('CAS conflict'));await ui.formProps.onFinish({...ui.values});await flush();expect(render()).toContain('CAS conflict');
  expect(base.patch).toHaveBeenCalledWith(expect.any(String),{defaultBytes:2*1024**3,maximumBytes:64*1024**3,expectedRevision:0},expect.any(Object));expect(ui.values.maximumMiB).toBe(65536);
 });
 it('explicit refresh adopts the revision while preserving the draft, then saves the exact acknowledged values',async()=>{
  await load();edit();vi.mocked(base.get).mockResolvedValueOnce({data:policy({revision:2})});ui.buttons.get('Обновить сведения').onClick();await flush();render();
  vi.mocked(base.patch).mockResolvedValueOnce({data:policy({defaultBytes:2*1024**3,maximumBytes:64*1024**3,revision:3})});await ui.formProps.onFinish({...ui.values});await flush();render();
  expect(vi.mocked(base.patch).mock.calls[0][1]).toMatchObject({expectedRevision:2});expect(ui.buttons.get('Сохранить настройки квот').disabled).toBe(true);
 });
 it('ignores an old-owner response and cancels on unmount',async()=>{
  const late=deferred<any>();vi.mocked(base.get).mockReturnValueOnce(late.promise);render();ui.owner='other';late.resolve({data:policy()});await flush();render();expect(ui.formProps).toBeUndefined();
  ui.effects[0].cleanup?.();expect(vi.mocked(base.get).mock.calls[0][1]?.signal?.aborted).toBe(true);
 });
 it('does not duplicate a save or refresh over a pending save, and retains a failed draft',async()=>{
  await load();edit();const pending=deferred<any>();vi.mocked(base.patch).mockReturnValueOnce(pending.promise);const first=ui.formProps.onFinish({...ui.values});ui.formProps.onFinish({...ui.values});ui.refresh!();expect(base.patch).toHaveBeenCalledTimes(1);expect(base.get).toHaveBeenCalledTimes(1);
  pending.resolve({data:policy({defaultBytes:3*1024**3,maximumBytes:64*1024**3,revision:1})});await first;await flush();expect(render()).toContain('Сервер не подтвердил выбранные значения');expect(ui.values.defaultMiB).toBe(2048);
 });
 it('reports a load failure and prevents invalid values and inverted limits',async()=>{
  vi.mocked(base.get).mockRejectedValueOnce(Error('offline'));expect(await load()).toContain('offline');expect(ui.formProps).toBeUndefined();
  vi.mocked(base.get).mockResolvedValueOnce({data:policy()});ui.buttons.get('Обновить сведения').onClick();await flush();render();
  const rules=ui.fields.get('defaultMiB').rules;await expect(rules[1].validator(null,0)).rejects.toThrow();await expect(rules[1].validator(null,1)).resolves.toBeUndefined();
  ui.values.defaultMiB=2;await expect(ui.fields.get('maximumMiB').rules[2].validator(null,1)).rejects.toThrow('Максимум');await expect(ui.fields.get('maximumMiB').rules[2].validator(null,2)).resolves.toBeUndefined();
 });
 it('does not send a save after owner revocation and never applies a late save to another owner',async()=>{
  await load();edit();const submit=ui.formProps.onFinish;ui.owner='other';await submit({...ui.values});expect(base.patch).not.toHaveBeenCalled();
  ui.owner='main';const late=deferred<any>();vi.mocked(base.patch).mockReturnValueOnce(late.promise);const pending=submit({...ui.values});ui.owner='other';late.resolve({data:policy({defaultBytes:2*1024**3,maximumBytes:64*1024**3,revision:1})});await pending;await flush();expect(ui.values.defaultMiB).toBe(2048);ui.user=false;expect(render()).toBe('');
 });
});
