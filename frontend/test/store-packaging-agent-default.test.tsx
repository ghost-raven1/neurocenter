// @vitest-environment jsdom
import {act,createElement} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {usePackagingAgent} from '../src/modules/Store/packaging/usePackagingAgent';
import type {ICatalogModel,IModelCatalog} from '../src/features/ModelCatalog/types';

const f=vi.hoisted(()=>({list:vi.fn(),captureOwner:()=>()=>true}));
vi.mock('../src/features/ModelCatalog/api',()=>({modelCatalogApi:{list:f.list}}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner',()=>({useAuthRequestOwner:()=>({captureOwner:f.captureOwner})}));
const pin='a'.repeat(64),other='b'.repeat(64);
const model=(id:string,extra:Partial<ICatalogModel>={}):ICatalogModel=>({id:'model-'+id,name:id,description:'Verified',capability:'chat',runtime:'remote-openai',model:id,manifestSha256:null,
 verificationSha256:other,modelPin:pin,dimension:null,source:'custom',revision:1,createdAt:'2026-10-25',updatedAt:'2026-10-25',...extra});
const catalog=(items:ICatalogModel[]):IModelCatalog=>({items,assignedModelIds:[]});
let root:Root,host:HTMLDivElement,agent:ReturnType<typeof usePackagingAgent>;
function Probe({scope}:{scope:string}){agent=usePackagingAgent(scope,true,true,false);return null;}
async function render(scope='owner-a'){await act(async()=>{root.render(createElement(Probe,{scope}));});}
async function change(work:()=>void){await act(async()=>{work();});}
beforeEach(()=>{vi.clearAllMocks();Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();});

it('selects the first eligible model only after assistance is enabled, without submitting a build',async()=>{
 f.list.mockResolvedValue(catalog([model('unchecked',{verificationSha256:null}),model('embedding',{capability:'embedding'}),model('first'),model('second')]));
 await render();expect(f.list).not.toHaveBeenCalled();
 await change(()=>agent.setChecked(true));expect(agent.selection).toEqual({modelId:'model-first',expectedModelPin:pin,maxAttempts:3});
 expect(f.list).toHaveBeenCalledOnce();expect(agent.blocker).toBe('');
});
it('keeps the chosen pin when refreshed catalog order or model version changes',async()=>{
 f.list.mockResolvedValue(catalog([model('first'),model('second')]));await render();await change(()=>agent.setChecked(true));await change(()=>agent.choose('model-second'));
 f.list.mockResolvedValue(catalog([model('third'),model('second',{modelPin:other})]));await change(()=>agent.refresh());
 expect(agent.selection).toEqual({modelId:'model-second',expectedModelPin:pin,maxAttempts:3});expect(agent.blocker).toContain('версия модели недоступна');
});
it('preserves restored absence and an exact pending request instead of applying defaults',async()=>{
 f.list.mockResolvedValue(catalog([model('first')]));await render();await change(()=>agent.restore());await change(()=>agent.setChecked(true));expect(agent.selection).toBeUndefined();
 await change(()=>agent.restore({modelId:'saved',expectedModelPin:other,maxAttempts:1}));await change(()=>agent.refresh());
 expect(agent.selection).toEqual({modelId:'saved',expectedModelPin:other,maxAttempts:1});
});
it('does not let a late catalog response choose a model for another owner',async()=>{
 let finish!:(value:IModelCatalog)=>void;f.list.mockImplementationOnce(()=>new Promise<IModelCatalog>(resolve=>{finish=resolve;}));
 await render();await change(()=>agent.setChecked(true));f.list.mockResolvedValue(catalog([model('owner-b-model')]));await render('owner-b');await change(()=>agent.setChecked(true));
 await change(()=>finish(catalog([model('owner-a-model')])));expect(agent.selection?.modelId).toBe('model-owner-b-model');
});
it('waits for an eligible model after an empty response and resets only for a new draft',async()=>{
 f.list.mockResolvedValue(catalog([]));await render();await change(()=>agent.setChecked(true));expect(agent.selection).toBeUndefined();
 f.list.mockResolvedValue(catalog([model('available')]));await change(()=>agent.refresh());expect(agent.selection?.modelId).toBe('model-available');
 await change(()=>agent.clear());f.list.mockResolvedValue(catalog([model('new-draft')]));await change(()=>agent.setChecked(true));expect(agent.selection?.modelId).toBe('model-new-draft');
});
