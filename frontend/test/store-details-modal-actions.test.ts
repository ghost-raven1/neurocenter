import './feature-flags-enabled';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {deferredModal,flushModal,modalAntd,uiNode} from './modal-actions.fixture';
const h=await vi.hoisted(async()=>{const f=await import('./modal-actions.fixture');return {hooks:f.modalHooks(),ui:f.modalUi(),small:true,live:()=>{},close:vi.fn(),edit:vi.fn(),install:vi.fn(),add:vi.fn(),choose:vi.fn()};});
vi.mock('react',async original=>({...await original<typeof import('react')>(),useState:h.hooks.state,useEffect:h.hooks.effect}));
vi.mock('antd',async()=>({...modalAntd(h.ui,(await import('react')).createElement),Grid:{useBreakpoint:()=>({sm:h.small})},message:{success:vi.fn(),error:vi.fn()}}));
vi.mock('../src/core/api/bff',()=>({default:{getSkill:vi.fn(),getAiPlugin:vi.fn(),listAiPluginVersions:vi.fn()}}));
vi.mock('../src/core/socket/useSectionUpdates',()=>({useSectionUpdates:(_sections:unknown,fn:()=>void)=>{h.live=fn;}}));
vi.mock('../src/modules/Store/AppCard',()=>({KindBadge:({kind}:any)=>createElement('span',null,kind)}));
vi.mock('../src/modules/Store/StoreInstruction',()=>({default:({body}:any)=>createElement('article',null,body)}));
vi.mock('../src/modules/Store/StoreBundleContent',()=>({StoreBundleContent:(props:any)=>{h.ui.nodes.push({kind:'Bundle',props,text:''});return createElement('div',null,props.plugin.name);}}));
vi.mock('../src/modules/Store/StoreDetailsInstall',()=>({default:()=>null,StoreDetailsInstallButton:(props:any)=>{h.ui.nodes.push({kind:'Install',props,text:''});return null;}}));
import StoreDetailsModal from '../src/modules/Store/StoreDetailsModal';
import bff from '../src/core/api/bff';
import {message} from 'antd';
const plugin={id:'tool',kind:'mcp',name:'Full Tool',description:'Full detail',version:7,tags:['RAG'],config:null,origin:'https://github.com/team/tool',revision:'v1.2.3',createdAt:'2026-10-01',updatedAt:'2026-10-02'} as any;
const skill={path:'common/tool',body:'# Skill body',resources:[],meta:{name:'Full skill',description:'Skill summary',scope:'common',owner:'owner',version:3,tags:['skill'],projectId:'prj-test',specialization:'QA',updatedAt:'2026-10-01',mcp:['mcp-one'],plugins:['plugin-one'],history:[{version:2,at:'2026-09-01',author:'before',note:'Old'},{version:3,at:'2026-10-01',author:'now',note:'Current'}]}} as any;
let app:any,props:any;
function render(){h.hooks.begin();h.ui.nodes=[];const html=renderToStaticMarkup(createElement(StoreDetailsModal,{viewApp:app,onClose:h.close,...props}));h.hooks.commit();return html;}
async function open(kind='mcp'){app={id:'tool',kind,name:'List Tool',version:2,...(kind==='skill'?{path:'common/tool'}:{})};render();await flushModal();return render();}
const tab=(name:string)=>{uiNode(h.ui,'Tabs').onChange(name);return render();};
beforeEach(()=>{h.hooks.dispose();vi.clearAllMocks();h.small=true;app=null;props={};vi.mocked(bff.getAiPlugin).mockResolvedValue(plugin);vi.mocked(bff.getSkill).mockResolvedValue(skill);vi.mocked(bff.listAiPluginVersions).mockResolvedValue([{version:6,createdAt:'bad'},{version:7,createdAt:'2026-10-01',author:'admin',note:'Current'}] as any);});
afterEach(()=>{h.hooks.dispose();vi.unstubAllGlobals();});
describe('Store detail actual modal lifecycle',()=>{
 it('uses fetched version for installation and only exposes optional actions supplied by authorized parent',async()=>{
  expect(render()).not.toContain('Редактировать');props={onInstall:h.install,onEdit:h.edit,onAddToProject:h.add,onChooseProjectFolder:h.choose,projectName:'QA',archiveAction:createElement('span',null,'Archive approved')};expect(await open()).toContain('Archive approved');expect(render()).toContain('Выбранный проект: QA');uiNode(h.ui,'Install').onInstall();expect(h.install).toHaveBeenCalledWith(7);uiNode(h.ui,'Button','Редактировать').onClick();uiNode(h.ui,'Button','Добавить в проект').onClick();uiNode(h.ui,'Button','Выбрать папку').onClick();expect(h.edit).toHaveBeenCalledOnce();expect(h.add).toHaveBeenCalledOnce();expect(h.choose).toHaveBeenCalledOnce();uiNode(h.ui,'Button','Закрыть').onClick();uiNode(h.ui,'Modal').onCancel();expect(h.close).toHaveBeenCalledTimes(2);
 });
 it('Новая версия — отдельное действие от редактирования метаданных',async()=>{
  const update=vi.fn();props={onNewVersion:update,onEdit:h.edit};await open();expect(uiNode(h.ui,'Button','Новая версия').disabled).toBe(false);uiNode(h.ui,'Button','Новая версия').onClick();expect(update).toHaveBeenCalledOnce();expect(h.edit).not.toHaveBeenCalled();
 });
 it('refresh network failure preserves content but disables mutations, retry recovers',async()=>{
  props={onEdit:h.edit,onInstall:h.install};await open();vi.mocked(bff.getAiPlugin).mockRejectedValueOnce(Error('Offline'));h.live();render();await flushModal();expect(render()).toContain('Не удалось обновить данные');expect(render()).toContain('Full detail');expect(uiNode(h.ui,'Button','Редактировать').disabled).toBe(true);expect(uiNode(h.ui,'Install').disabled).toBe(true);uiNode(h.ui,'Button','Повторить').onClick();render();await flushModal();expect(render()).not.toContain('Не удалось обновить данные');expect(uiNode(h.ui,'Install').disabled).toBe(false);
 });
 it.each([401,403,404,410])('refresh HTTP%s removes former private content and requires successful re-read',async status=>{
  await open();vi.mocked(bff.getAiPlugin).mockRejectedValueOnce({isAxiosError:true,response:{status,data:{message:'Access gone'}}});h.live();render();await flushModal();const html=render();expect(html).toContain('Не удалось открыть инструмент');expect(html).not.toContain('Full detail');expect(h.ui.nodes.some(n=>n.kind==='Bundle')).toBe(false);
 });
 it('late old-card read and history cannot replace the newly opened card',async()=>{
  const wait=deferredModal<any>();vi.mocked(bff.getAiPlugin).mockReturnValueOnce(wait.promise);app={id:'old',kind:'plugin',name:'Old',version:1};render();await open('skill');wait.resolve({...plugin,name:'Stale private'});await flushModal();expect(render()).not.toContain('Stale private');
  await open();const history=deferredModal<any>();vi.mocked(bff.listAiPluginVersions).mockReturnValueOnce(history.promise);tab('history');await open('skill');history.resolve([{version:99,author:'Stale history'}]);await flushModal();expect(render()).not.toContain('Stale history');
 });
 it('skill source mode, copy and metadata retain full instruction, dependencies and sorted real history',async()=>{
  const clipboard={writeText:vi.fn().mockResolvedValue(undefined)};vi.stubGlobal('navigator',{clipboard});await open('skill');uiNode(h.ui,'RadioGroup').onChange({target:{value:'source'}});const html=render();expect(html).toContain('# Skill body');expect(html).toContain('mcp-one');expect(html).toContain('plugin-one');expect(html.indexOf('Current')).toBeLessThan(html.indexOf('Old'));uiNode(h.ui,'Button','Копировать инструкцию').onClick();await flushModal();expect(clipboard.writeText).toHaveBeenCalledExactlyOnceWith(skill.body);expect(message.success).toHaveBeenCalledWith('Скопировано');
  uiNode(h.ui,'RadioGroup').onChange({target:{value:'read'}});render();
 });
 it.each(['absent','reject'])('clipboard %s gives recovery advice instead of a false success',async mode=>{
  vi.stubGlobal('navigator',mode==='absent'?{}:{clipboard:{writeText:vi.fn().mockRejectedValue(Error('Clipboard denied'))}});await open('skill');uiNode(h.ui,'Button','Копировать инструкцию').onClick();await flushModal();expect(message.error).toHaveBeenCalled();expect(message.success).not.toHaveBeenCalled();
 });
 it('empty instruction/history and missing optional metadata remain honest and cannot copy blank content',async()=>{
  vi.mocked(bff.getSkill).mockResolvedValue({...skill,body:' ',meta:{...skill.meta,scope:'project',owner:'',description:'',tags:undefined,updatedAt:'bad',history:[],mcp:[],plugins:[],projectId:undefined,specialization:undefined}});expect(await open('skill')).toContain('Инструкция пока не добавлена');const html=render();expect(html).toContain('История изменений пока пуста');expect(html).toContain('Описание пока не добавлено');expect(html).toContain('Не указан');expect(uiNode(h.ui,'Button','Копировать инструкцию').disabled).toBe(true);
 });
 it('bundle history loads on demand, handles outage/retry and renders empty truthful result',async()=>{
  await open();expect(bff.listAiPluginVersions).not.toHaveBeenCalled();vi.mocked(bff.listAiPluginVersions).mockRejectedValueOnce(Error('History offline'));tab('history');await flushModal();expect(render()).toContain('History offline');uiNode(h.ui,'Button','Повторить').onClick();render();await flushModal();const html=render();expect(html.indexOf('Редакция 7')).toBeLessThan(html.indexOf('Редакция 6'));
  vi.mocked(bff.listAiPluginVersions).mockResolvedValue([]);h.live();render();await flushModal();render();await flushModal();expect(render()).toContain('История версий пока пуста');
 });
 it('project pinned snapshot is rendered without silently fetching a newer common card',async()=>{
  app={id:'tool',kind:'plugin',name:'Pinned',version:4,projectManifest:'a'.repeat(64),projectCard:{kind:'bundle',plugin:{...plugin,version:4,description:'Pinned project',origin:'opaque-source',revision:'unknown-ref',compatibility:'OpenCode'}}};props={onInstall:h.install,installUnavailableReason:'Bind first',onAddToProject:h.add};render();await flushModal();expect(render()).toContain('Pinned project');expect(render()).toContain('Добавьте инструмент в проект');expect(bff.getAiPlugin).not.toHaveBeenCalled();uiNode(h.ui,'Bundle').onCopy('masked config');await flushModal();expect(message.error).toHaveBeenCalled();uiNode(h.ui,'Install').onInstall();expect(h.install).toHaveBeenCalledWith(4);
 });
 it('initial load error retries; folder preparation and missing skill path are explicit',async()=>{
  props={onChooseProjectFolder:h.choose,installUnavailableReason:'No folder'};vi.mocked(bff.getAiPlugin).mockRejectedValueOnce(Error('Initial outage'));expect(await open()).toContain('Подготовьте папку проекта');expect(render()).toContain('Не удалось открыть инструмент');uiNode(h.ui,'Button','Повторить').onClick();render();await flushModal();expect(render()).toContain('Full detail');
  app={id:'broken',kind:'skill',version:1,name:'Missing path'};render();await flushModal();expect(render()).toContain('не указан путь');
 });
 it('narrow metadata and historical missing values use honest defaults without inventing authors or sources',async()=>{
  h.small=false;vi.mocked(bff.getAiPlugin).mockResolvedValue({...plugin,origin:undefined,revision:undefined,compatibility:undefined});props={installUnavailableReason:'No current computer'};const html=await open();expect(html).toContain('Установка пока недоступна');expect(uiNode(h.ui,'Descriptions').column).toBe(1);expect(html).toContain('Не указан');
  vi.mocked(bff.getSkill).mockResolvedValue({...skill,meta:{...skill.meta,history:[{version:1,at:'bad'}]}});expect(await open('skill')).toContain('Автор не указан');expect(render()).toContain('Комментарий к версии не добавлен');vi.mocked(bff.getSkill).mockResolvedValue({...skill,meta:{...skill.meta,history:undefined}});h.live();render();await flushModal();expect(render()).toContain('История изменений пока пуста');
 });
 it('cancelled old history and read errors never appear on the new card',async()=>{
  await open();const history=deferredModal<any>();vi.mocked(bff.listAiPluginVersions).mockReturnValueOnce(history.promise);tab('history');await open('skill');history.reject(Error('Old history outage'));await flushModal();expect(render()).not.toContain('Old history outage');const read=deferredModal<any>();vi.mocked(bff.getAiPlugin).mockReturnValueOnce(read.promise);app={id:'old',kind:'plugin',version:1,name:'Old'};render();await open('skill');read.reject(Error('Old card outage'));await flushModal();expect(render()).not.toContain('Old card outage');
 });
});
