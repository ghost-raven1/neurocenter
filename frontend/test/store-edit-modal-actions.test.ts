import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {deferredModal,flushModal,modalAntd,uiNode} from './modal-actions.fixture';
const h=await vi.hoisted(async()=>{const f=await import('./modal-actions.fixture');const state={hooks:f.modalHooks(),ui:f.modalUi(),owner:'a',active:true,enabled:true,live:()=>{},saved:vi.fn(),close:vi.fn()};return {...state,capture:()=>{const owner=state.owner;return ()=>state.active&&owner===state.owner;},ownerState:state};});
vi.mock('react',async original=>({...await original<typeof import('react')>(),useState:h.hooks.state,useRef:h.hooks.ref,useEffect:h.hooks.effect}));
vi.mock('antd',async()=>({...modalAntd(h.ui,(await import('react')).createElement),message:{success:vi.fn(),warning:vi.fn()}}));
vi.mock('../src/core/api/bff',()=>({default:{getSkill:vi.fn(),getAiPlugin:vi.fn(),updateSkill:vi.fn(),updateAiPlugin:vi.fn()}}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner',()=>({useAuthRequestOwner:()=>({captureOwner:h.capture})}));
vi.mock('../src/core/socket/useSectionUpdates',()=>({useSectionUpdates:(_sections:unknown,fn:()=>void)=>{h.live=fn;}}));
vi.mock('../src/features/FeatureFlags/FeatureAvailability',async()=>({useFeatureAvailability:()=>({enabled:h.enabled}),FeatureButton:(props:any)=>createElement('button',props,props.children)}));
vi.mock('../src/features/Catalog/publication/SkillResourceEditor',()=>({SkillResources:(props:any)=>{h.ui.nodes.push({kind:'Resources',props,text:''});return null;}}));
vi.mock('../src/features/Catalog/publication/DependencyPinsEditor',()=>({DependencyPinsEditor:(props:any)=>{h.ui.nodes.push({kind:'Dependencies',props,text:''});return null;}}));
vi.mock('../src/features/Catalog/skillMutationFeedback',()=>({notifySkillMutation:vi.fn()}));
import StoreEditModal from '../src/features/Catalog/StoreEditModal';
import bff from '../src/core/api/bff';
import {notifySkillMutation} from '../src/features/Catalog/skillMutationFeedback';
import {message} from 'antd';
const plugin={id:'tool',kind:'mcp',name:'Tool',description:'Original',tags:['one'],version:7,config:{transport:'stdio',command:'node',args:['server.js']},dependencies:[]} as any;
const skill={path:'common/tool',body:'# Original',resources:[],meta:{name:'Skill',description:'Original',tags:[],version:3,mcp:['old-mcp'],plugins:[],dependencies:[]}} as any;
let app:any;
function render(){h.hooks.begin();h.ui.nodes=[];h.ui.fields.clear();const html=renderToStaticMarkup(createElement(StoreEditModal,{editApp:app,onClose:h.close,onSaved:h.saved}));h.hooks.commit();return html;}
async function open(kind='mcp'){app={id:'tool',name:'Tool',kind,...(kind==='skill'?{path:'common/tool'}:{})};render();await flushModal();return render();}
function change(patch:Record<string,any>){Object.assign(h.ui.values,patch);h.ui.change({},structuredClone(h.ui.values));render();}
function submit(){h.ui.finish(structuredClone(h.ui.values));}
beforeEach(()=>{h.hooks.dispose();vi.clearAllMocks();h.ownerState.owner='a';h.ownerState.active=true;h.enabled=true;h.ui.values={};app=null;vi.mocked(bff.getAiPlugin).mockResolvedValue(plugin);vi.mocked(bff.getSkill).mockResolvedValue(skill);vi.mocked(bff.updateAiPlugin).mockResolvedValue(plugin);vi.mocked(bff.updateSkill).mockResolvedValue({path:skill.path,state:'saved'} as any);});
afterEach(()=>{h.hooks.dispose();vi.unstubAllGlobals();});
describe('Store edit actual modal actions',()=>{
 it('saves the loaded MCP CAS revision once, preserves exact argument strings, then closes',async()=>{
  await open();submit();expect(bff.updateAiPlugin).not.toHaveBeenCalled();change({description:'Changed',config:JSON.stringify({...plugin.config,args:['path with spaces/server.js']})});
  const wait=deferredModal<any>();vi.mocked(bff.updateAiPlugin).mockReturnValueOnce(wait.promise);submit();submit();uiNode(h.ui,'Modal').onCancel();expect(h.close).not.toHaveBeenCalled();
  expect(bff.updateAiPlugin).toHaveBeenCalledExactlyOnceWith('tool',expect.objectContaining({expectedVersion:7,description:'Changed',config:expect.objectContaining({args:['path with spaces/server.js']})}));wait.resolve(plugin);await flushModal();expect(h.saved).toHaveBeenCalledOnce();expect(h.close).toHaveBeenCalledOnce();
 });
 it('skill save retains resources and legacy requirements until explicit removal',async()=>{
  await open('skill');change({name:'New skill',body:'# Edited',clearLegacyRequirements:true});submit();await flushModal();expect(bff.updateSkill).toHaveBeenCalledWith(skill.path,expect.objectContaining({expectedVersion:3,name:'New skill',body:'# Edited',meta:expect.objectContaining({mcp:[],plugins:[]})}));expect(notifySkillMutation).toHaveBeenCalledOnce();
 });
 it('a network failure preserves the draft and retry uses the same original revision',async()=>{
  await open();change({description:'Keep my draft'});vi.mocked(bff.updateAiPlugin).mockRejectedValueOnce(Object.assign(Error('Network Error'),{isAxiosError:true}));submit();await flushModal();expect(render()).toContain('Правки остались в форме');expect(h.ui.values.description).toBe('Keep my draft');submit();await flushModal();expect(bff.updateAiPlugin).toHaveBeenCalledTimes(2);expect(vi.mocked(bff.updateAiPlugin).mock.calls[1][1]).toHaveProperty('expectedVersion',7);
 });
 it('conflict recovery keeps the old draft, loads new CAS version and copies either draft safely',async()=>{
  const clipboard={writeText:vi.fn().mockResolvedValue(undefined)};vi.stubGlobal('navigator',{clipboard});await open();change({description:'Local changes'});vi.mocked(bff.updateAiPlugin).mockRejectedValueOnce({response:{status:409,data:{message:'Version changed'}}});submit();await flushModal();render();uiNode(h.ui,'Button','Скопировать правки').onClick();await flushModal();expect(JSON.parse(clipboard.writeText.mock.calls[0][0]).description).toBe('Local changes');
  vi.mocked(bff.getAiPlugin).mockResolvedValue({...plugin,version:8,description:'Server latest'});uiNode(h.ui,'Button','Загрузить актуальную версию').onClick();render();await flushModal();expect(render()).toContain('Предыдущий черновик');expect(h.ui.values.description).toBe('Server latest');uiNode(h.ui,'Button','Показать черновик').onClick();expect(render()).toContain('Скрыть черновик');uiNode(h.ui,'Button','Скопировать черновик').onClick();await flushModal();expect(JSON.parse(clipboard.writeText.mock.calls[1][0]).description).toBe('Local changes');
  change({description:'Merged'});submit();await flushModal();expect(vi.mocked(bff.updateAiPlugin).mock.calls[1][1]).toHaveProperty('expectedVersion',8);
 });
 it('failed reads can retry and a skill without catalog path gives actionable failure',async()=>{
  vi.mocked(bff.getAiPlugin).mockRejectedValueOnce(Error('Unavailable'));expect(await open()).toContain('Не удалось открыть инструмент');uiNode(h.ui,'Button','Повторить загрузку').onClick();render();await flushModal();expect(render()).toContain('Версия 7');
  app={id:'missing',kind:'skill',name:'Broken'};render();await flushModal();expect(render()).toContain('отсутствует путь');
 });
 it.each(['owner','card'])('late save after %s change cannot close or replace the active modal',async issue=>{
  await open();change({description:'Edit'});const wait=deferredModal<any>();vi.mocked(bff.updateAiPlugin).mockReturnValueOnce(wait.promise);submit();if(issue==='owner')h.ownerState.owner='b';else{app={...app,id:'another'};render();await flushModal();}wait.resolve(plugin);await flushModal();expect(h.saved).not.toHaveBeenCalled();expect(h.close).not.toHaveBeenCalled();
 });
 it('stale reads are ignored after changing card and feature/owner/resource guards refuse saves',async()=>{
  const wait=deferredModal<any>();vi.mocked(bff.getAiPlugin).mockReturnValueOnce(wait.promise);app={id:'old',kind:'mcp',name:'Old'};render();app={id:'new',kind:'plugin',name:'New'};render();await flushModal();render();wait.resolve({...plugin,name:'Stale'});await flushModal();render();expect(h.ui.values.name).not.toBe('Stale');
  change({description:'Changed'});h.enabled=false;render();submit();h.enabled=true;h.ownerState.owner='b';submit();expect(bff.updateAiPlugin).not.toHaveBeenCalled();
  h.ownerState.owner='a';await open('skill');change({body:'# changed'});uiNode(h.ui,'Resources').onLoadingChange(true);render();submit();expect(bff.updateSkill).not.toHaveBeenCalled();uiNode(h.ui,'Resources').onLoadingChange(false);uiNode(h.ui,'Dependencies').onLoadingChange(true);render();submit();expect(bff.updateSkill).not.toHaveBeenCalled();
 });
 it('live newer version warns without overwriting draft and only latest comparison wins',async()=>{
  await open();change({description:'Unsaved'});const first=deferredModal<any>(),second=deferredModal<any>();vi.mocked(bff.getAiPlugin).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);h.live();h.live();second.resolve({...plugin,version:9});await flushModal();first.resolve({...plugin,version:8});await flushModal();expect(render()).toContain('версия 9');expect(h.ui.values.description).toBe('Unsaved');
  vi.mocked(bff.getAiPlugin).mockRejectedValueOnce(Error('offline'));h.live();await flushModal();expect(render()).toContain('версия 9');
 });
 it('field validation refuses invalid tags, raw secrets, resources and oversized skill instructions',async()=>{
  await open();await expect(h.ui.fields.get('tags').rules[0].validator(null,Array(21).fill('tag').map((x,i)=>x+i).join(','))).rejects.toThrow();await expect(h.ui.fields.get('config').rules[0].validator(null,'{"transport":"stdio","command":"node","env":{"API_KEY":"secret"}}')).rejects.toThrow();
  await open('skill');await expect(h.ui.fields.get('body').rules[1].validator(null,'\0')).rejects.toThrow();await expect(h.ui.fields.get('body').rules[1].validator(null,'я'.repeat(600000))).rejects.toThrow();await expect(h.ui.fields.get('body').rules[1].validator(null,'# valid')).resolves.toBeUndefined();
  for(const [field,tab]of [['dependencies','dependencies'],['body','body'],['resources','body'],['config','config'],['name','card']]){h.ui.failed({errorFields:[{name:[field]}]});render();expect(uiNode(h.ui,'Tabs').activeKey).toBe(tab);}
  await expect(h.ui.fields.get('dependencies').rules[0].validator(null,[{invalid:true}])).rejects.toThrow();change({resources:[{path:'../escape',content:'x'}]});submit();await flushModal();expect(bff.updateSkill).not.toHaveBeenCalled();
 });
 it('a closed editor performs no reads; cancel is guarded during resource reads and a save',async()=>{
  render();h.live();expect(bff.getAiPlugin).not.toHaveBeenCalled();expect(uiNode(h.ui,'Modal').open).toBe(false);await open('skill');uiNode(h.ui,'Resources').onLoadingChange(true);render();uiNode(h.ui,'Modal').onCancel();uiNode(h.ui,'Button','Отмена').onClick();expect(h.close).not.toHaveBeenCalled();uiNode(h.ui,'Resources').onLoadingChange(false);render();uiNode(h.ui,'Button','Отмена').onClick();uiNode(h.ui,'Modal').onCancel();expect(h.close).toHaveBeenCalledTimes(2);
  change({body:'# Saving'});const wait=deferredModal<any>();vi.mocked(bff.updateSkill).mockReturnValueOnce(wait.promise);submit();render();h.live();uiNode(h.ui,'Button','Отмена').onClick();expect(h.close).toHaveBeenCalledTimes(2);wait.resolve({state:'saved'});await flushModal();
 });
 it('clipboard refusal preserves the draft and late clipboard success cannot notify a different owner',async()=>{
  const writeText=vi.fn().mockRejectedValueOnce(Error('denied'));vi.stubGlobal('navigator',{clipboard:{writeText}});await open();change({description:'Keep'});vi.mocked(bff.updateAiPlugin).mockRejectedValueOnce(Error('Save failed'));submit();await flushModal();render();uiNode(h.ui,'Button','Скопировать правки').onClick();await flushModal();expect(message.warning).toHaveBeenCalledOnce();expect(h.ui.values.description).toBe('Keep');
  const wait=deferredModal<void>();writeText.mockReturnValueOnce(wait.promise);uiNode(h.ui,'Button','Скопировать правки').onClick();h.ownerState.owner='b';wait.resolve();await flushModal();expect(message.success).not.toHaveBeenCalled();
 });
 it('legacy optional metadata loads safely and live skill comparisons do not replace project drafts',async()=>{
  vi.mocked(bff.getAiPlugin).mockResolvedValueOnce({...plugin,config:null,dependencies:undefined});await open('plugin');expect(h.ui.values.config).toBe('{}');expect(h.ui.values.dependencies).toEqual([]);await expect(h.ui.fields.get('tags').rules[0].validator(null,undefined)).resolves.toBeUndefined();await expect(h.ui.fields.get('dependencies').rules[0].validator(null,undefined)).resolves.toBeUndefined();
  vi.mocked(bff.getSkill).mockResolvedValue({...skill,path:'project/tool',resources:undefined,meta:{...skill.meta,description:undefined,dependencies:undefined}});app={id:'project-skill',kind:'skill',path:'project/tool',name:'Project skill'};render();await flushModal();render();expect(h.ui.values.resources).toEqual([]);expect(h.ui.fields.get('description').rules[0].required).toBe(false);await expect(h.ui.fields.get('body').rules[1].validator(null,undefined)).resolves.toBeUndefined();change({body:'# unsaved'});h.live();await flushModal();expect(render()).not.toContain('Карточка изменена на сервере');vi.mocked(bff.getSkill).mockResolvedValue({...skill,meta:{...skill.meta,version:4}});h.live();await flushModal();expect(render()).toContain('версия 4');expect(h.ui.values.body).toBe('# unsaved');
 });
 it('late read/save errors from a replaced card cannot overwrite the active form',async()=>{
  const read=deferredModal<any>();vi.mocked(bff.getAiPlugin).mockReturnValueOnce(read.promise);app={id:'first',kind:'mcp',name:'First'};render();app={id:'second',kind:'plugin',name:'Second'};render();await flushModal();read.reject(Error('First failed'));await flushModal();expect(render()).not.toContain('First failed');change({description:'Second edit'});const save=deferredModal<any>();vi.mocked(bff.updateAiPlugin).mockReturnValueOnce(save.promise);submit();app={id:'third',kind:'plugin',name:'Third'};render();await flushModal();save.reject(Error('Second failed'));await flushModal();expect(render()).not.toContain('Second failed');expect(h.close).not.toHaveBeenCalled();
 });
 it('auth invalidation before React re-render refuses both save and copying a private draft',async()=>{
  const writeText=vi.fn();vi.stubGlobal('navigator',{clipboard:{writeText}});await open();change({description:'Private draft'});vi.mocked(bff.updateAiPlugin).mockRejectedValueOnce(Error('Save failed'));submit();await flushModal();render();h.ownerState.active=false;uiNode(h.ui,'Button','Скопировать правки').onClick();submit();await flushModal();expect(writeText).not.toHaveBeenCalled();expect(bff.updateAiPlugin).toHaveBeenCalledOnce();
 });
});
