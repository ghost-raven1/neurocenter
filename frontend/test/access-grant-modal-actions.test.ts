import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {deferredModal,flushModal,modalAntd,uiNode} from './modal-actions.fixture';
const h=await vi.hoisted(async()=>{const f=await import('./modal-actions.fixture');const owner={value:'a',active:true};return {hooks:f.modalHooks(),ui:f.modalUi(),owner,user:null as any,live:()=>{},capture:()=>{const key=owner.value;return ()=>owner.active&&owner.value===key;},saved:vi.fn(),close:vi.fn()};});
vi.mock('react',async original=>({...await original<typeof import('react')>(),useState:h.hooks.state,useRef:h.hooks.ref,useEffect:h.hooks.effect,useMemo:h.hooks.memo}));
vi.mock('antd',async()=>modalAntd(h.ui,(await import('react')).createElement));
vi.mock('react-redux',()=>({useSelector:(fn:any)=>fn({userBlock:{user:h.user}})}));
vi.mock('../src/core/api/bff',()=>({default:{listProjects:vi.fn(),getAccessUsers:vi.fn(),addProjectMember:vi.fn(),updateProjectMember:vi.fn(),removeProjectMember:vi.fn()}}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner',()=>({useAuthRequestOwner:()=>({captureOwner:h.capture})}));
vi.mock('../src/core/socket/useSectionUpdates',()=>({useSectionUpdates:(_sections:unknown,fn:()=>void)=>{h.live=fn;}}));
import AccessGrantModal from '../src/modules/Access/AccessGrantModal';
import bff from '../src/core/api/bff';
const email='target@example.test',projects=[{id:'prj-a',name:'Alpha'},{id:'prj-b',name:'Beta'},{id:'prj-c',name:'Gamma'}];
const ref=(id:string,role='Разработчик')=>({projectId:id,projectName:projects.find(x=>x.id===id)!.name,userId:'original-'+id,role});
const users=(accesses:any[]=[])=>({users:[{principalName:email,displayName:'Target',accesses}]});
let principal:string,open:boolean;
function render(){h.hooks.begin();h.ui.nodes=[];const html=renderToStaticMarkup(createElement(AccessGrantModal,{open,principalName:principal,onClose:h.close,onSaved:h.saved}));h.hooks.commit();return html;}
async function start(accesses:any[]=[]){vi.mocked(bff.getAccessUsers).mockResolvedValue(users(accesses) as any);render();await flushModal();return render();}
function choose(name:string,checked=true,role='Разработчик'){uiNode(h.ui,'Checkbox',name).onChange({target:{checked}});render();if(checked){h.ui.nodes.find(n=>n.kind==='Select'&&n.props['aria-label']==='Роль в проекте '+name)!.props.onChange(role);render();}}
const save=()=>uiNode(h.ui,'Modal').onOk();
beforeEach(()=>{h.hooks.dispose();vi.clearAllMocks();h.owner.value='a';h.owner.active=true;h.user={activeRole:'Главный админ',userRoles:['Главный админ']};principal=email;open=true;vi.mocked(bff.listProjects).mockResolvedValue({items:projects,page:1,size:100,total:3} as any);for(const method of ['addProjectMember','updateProjectMember','removeProjectMember']as const)vi.mocked(bff[method]).mockResolvedValue({ok:true} as any);});
afterEach(()=>h.hooks.dispose());
describe('Access grant modal actual mutation flow',()=>{
 it('adds, edits and removes only changed managed grants, using original member IDs and CAS roles',async()=>{
  await start([ref('prj-b','Наблюдатель'),ref('prj-c')]);choose('Alpha');choose('Beta',true,'Админ проекта');choose('Gamma',false);save();save();uiNode(h.ui,'Modal').onCancel();expect(h.close).not.toHaveBeenCalled();await flushModal();
  expect(bff.addProjectMember).toHaveBeenCalledExactlyOnceWith('prj-a',{principalName:email,role:'Разработчик'});expect(bff.updateProjectMember).toHaveBeenCalledExactlyOnceWith('prj-b','original-prj-b',{role:'Админ проекта',expectedRole:'Наблюдатель'});expect(bff.removeProjectMember).toHaveBeenCalledExactlyOnceWith('prj-c','original-prj-c','Разработчик');expect(h.saved).toHaveBeenCalledWith(email,true);expect(h.close).toHaveBeenCalledOnce();
 });
 it('partial failure retries only the remaining grant and reports the saved subset',async()=>{
  await start();choose('Alpha');choose('Beta');vi.mocked(bff.addProjectMember).mockResolvedValueOnce({} as any).mockRejectedValueOnce(Error('Beta offline'));save();await flushModal();expect(render()).toContain('Сохранено 1 из 2');expect(h.saved).toHaveBeenCalledWith(email,false);expect(h.close).not.toHaveBeenCalled();
  vi.mocked(bff.getAccessUsers).mockResolvedValue(users([{...ref('prj-a'),userId:'u-'+email}]) as any);save();await flushModal();expect(bff.addProjectMember).toHaveBeenCalledTimes(3);expect(vi.mocked(bff.addProjectMember).mock.calls[2][0]).toBe('prj-b');expect(h.close).toHaveBeenCalledOnce();
 });
 it('preflight rejects concurrent server edits, preserves comparison, and reload requires a fresh choice',async()=>{
  await start();choose('Alpha');vi.mocked(bff.getAccessUsers).mockResolvedValue(users([ref('prj-a','Наблюдатель')]) as any);save();await flushModal();expect(render()).toContain('изменились, пока окно');expect(bff.addProjectMember).not.toHaveBeenCalled();save();await flushModal();expect(bff.getAccessUsers).toHaveBeenCalledTimes(2);
  uiNode(h.ui,'Button','Загрузить актуальные назначения').onClick();expect(render()).toContain('Предыдущий выбор');expect(uiNode(h.ui,'Modal').okButtonProps.disabled).toBe(true);choose('Alpha',true,'Разработчик');save();await flushModal();expect(bff.updateProjectMember).toHaveBeenCalledWith('prj-a','original-prj-a',{role:'Разработчик',expectedRole:'Наблюдатель'});
 });
 it('live change comparison warns without silently overwriting selected roles and ignores old email results',async()=>{
  principal='';await start();uiNode(h.ui,'Input').onChange({target:{value:email}});render();choose('Alpha');const wait=deferredModal<any>();vi.mocked(bff.getAccessUsers).mockReturnValueOnce(wait.promise);h.live();uiNode(h.ui,'Input').onChange({target:{value:'other@example.test'}});render();wait.resolve(users([ref('prj-a')]));await flushModal();expect(render()).not.toContain('Назначения изменились');expect(uiNode(h.ui,'Input').value).toBe('other@example.test');
  uiNode(h.ui,'Input').onChange({target:{value:email}});render();choose('Alpha');vi.mocked(bff.getAccessUsers).mockResolvedValue(users([ref('prj-b')]) as any);h.live();await flushModal();expect(render()).toContain('Назначения изменились на сервере');
 });
 it('network failure during preflight keeps choice and can retry, while owner changes suppress late callbacks',async()=>{
  await start();choose('Alpha');vi.mocked(bff.getAccessUsers).mockRejectedValueOnce(Error('Preflight offline'));save();await flushModal();expect(render()).toContain('Preflight offline');expect(uiNode(h.ui,'Checkbox','Alpha').checked).toBe(true);
  const wait=deferredModal<any>();vi.mocked(bff.getAccessUsers).mockReturnValueOnce(wait.promise);save();h.owner.value='b';wait.resolve(users());await flushModal();expect(bff.addProjectMember).not.toHaveBeenCalled();expect(h.saved).not.toHaveBeenCalled();
 });
 it('new email is normalized, invalid email refuses mutation, search filters visible choices',async()=>{
  principal='';await start();uiNode(h.ui,'Input').onChange({target:{value:'not email'}});render();uiNode(h.ui,'Input').onBlur();expect(render()).toContain('корректную электронную почту');save();await flushModal();expect(bff.getAccessUsers).toHaveBeenCalledTimes(1);
  uiNode(h.ui,'Input').onChange({target:{value:' TARGET@EXAMPLE.TEST '}});render();uiNode(h.ui,'Input').onBlur();render();expect(uiNode(h.ui,'Input').value).toBe(email);choose('Alpha');uiNode(h.ui,'Search').onChange({target:{value:'Beta'}});render();expect(h.ui.nodes.filter(n=>n.kind==='Checkbox').map(n=>n.text)).toEqual(['Beta']);uiNode(h.ui,'Search').onChange({target:{value:'missing'}});expect(render()).toContain('Нет проектов с таким названием');uiNode(h.ui,'Input').onPressEnter();await flushModal();expect(bff.addProjectMember).toHaveBeenCalledWith('prj-a',{principalName:email,role:'Разработчик'});
 });
 it('project admin cannot change another admin and loses write actions when own role is revoked',async()=>{
  h.user={activeRole:'Админ проекта',userRoles:['Админ проекта'],projectRoles:projects.map(project=>({projectId:project.id,projectName:project.name,role:'Админ проекта'}))};await start([ref('prj-a','Админ проекта')]);expect(uiNode(h.ui,'Checkbox','Alpha').disabled).toBe(true);expect(render()).toContain('Изменяет главный админ');expect(h.ui.nodes.filter(n=>n.kind==='Select').every(n=>!n.props.options.some((x:any)=>x.value==='Админ проекта'))).toBe(true);
  choose('Beta');h.user={...h.user,projectRoles:[]};render();save();await flushModal();expect(render()).toContain('Права на управление проектами изменились');expect(bff.addProjectMember).not.toHaveBeenCalled();
 });
 it('loads all pages, retries incomplete pagination, ignores a cancelled load and supports closed modal',async()=>{
  vi.mocked(bff.listProjects).mockResolvedValueOnce({items:[projects[0]],page:1,size:1,total:2} as any).mockResolvedValueOnce({items:[],page:2,size:1,total:3} as any);expect(await start()).toContain('Список проектов изменился');save();expect(bff.addProjectMember).not.toHaveBeenCalled();uiNode(h.ui,'Button','Повторить').onClick();render();await flushModal();expect(render()).toContain('Alpha');
  h.hooks.dispose();const wait=deferredModal<any>();vi.mocked(bff.listProjects).mockReturnValueOnce(wait.promise);render();open=false;render();wait.resolve({items:projects,page:1,size:100,total:3});await flushModal();render();expect(uiNode(h.ui,'Modal').open).toBe(false);uiNode(h.ui,'Modal').onCancel();expect(h.close).toHaveBeenCalled();
 });
 it('empty managed scope and background failures stay actionable without granting access',async()=>{
  h.user={activeRole:'Наблюдатель',userRoles:['Наблюдатель'],projectRoles:[]};expect(await start()).toContain('Нет проектов, которыми вы можете управлять');expect(uiNode(h.ui,'Modal').okButtonProps.disabled).toBe(true);
  h.hooks.dispose();h.user={activeRole:'Главный админ',userRoles:['Главный админ']};await start();vi.mocked(bff.getAccessUsers).mockRejectedValueOnce(Error('Live unavailable'));h.live();await flushModal();expect(render()).toContain('Live unavailable');
 });
 it('unchanged choices and a synchronously invalidated auth owner cause no preflight or writes',async()=>{
  await start();save();expect(bff.getAccessUsers).toHaveBeenCalledTimes(1);choose('Alpha');h.owner.active=false;save();await flushModal();expect(bff.getAccessUsers).toHaveBeenCalledTimes(1);expect(bff.addProjectMember).not.toHaveBeenCalled();
 });
 it.each([1,2])('owner revocation after a real first write stops a %s-change batch and suppresses callbacks',async count=>{
  await start();choose('Alpha');if(count===2)choose('Beta');const write=deferredModal<any>();vi.mocked(bff.addProjectMember).mockReturnValueOnce(write.promise);save();await flushModal();expect(bff.addProjectMember).toHaveBeenCalledOnce();h.owner.value='b';write.resolve({});await flushModal();expect(bff.addProjectMember).toHaveBeenCalledOnce();expect(h.saved).not.toHaveBeenCalled();expect(h.close).not.toHaveBeenCalled();
 });
 it('a new employee without a row can receive a first grant and revoked-choice comparison names the removal',async()=>{
  principal='new@example.test';await start();h.live();await flushModal();render();choose('Alpha');save();await flushModal();expect(bff.addProjectMember).toHaveBeenCalledWith('prj-a',{principalName:principal,role:'Разработчик'});
  h.hooks.dispose();principal=email;await start([ref('prj-a')]);choose('Alpha',false);vi.mocked(bff.getAccessUsers).mockResolvedValue(users([ref('prj-a','Наблюдатель')]) as any);save();await flushModal();render();uiNode(h.ui,'Button','Загрузить актуальные назначения').onClick();expect(render()).toContain('отозвать доступ');
 });
 it('cancelled failed reads and stale background failures do not overwrite a newer owner',async()=>{
  const wait=deferredModal<any>();vi.mocked(bff.listProjects).mockReturnValueOnce(wait.promise);render();open=false;render();wait.reject(Error('Cancelled load'));await flushModal();expect(render()).not.toContain('Cancelled load');
  h.hooks.dispose();open=true;await start();const check=deferredModal<any>();vi.mocked(bff.getAccessUsers).mockReturnValueOnce(check.promise);h.live();h.owner.value='b';check.reject(Error('Old live failure'));await flushModal();expect(render()).not.toContain('Old live failure');
 });
});
