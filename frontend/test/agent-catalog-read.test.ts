import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useAgentCatalog } from '../src/features/AgentCatalog/useAgentCatalog';
import { agentCatalogApi } from '../src/features/AgentCatalog/api';
import { catalog, delivery } from './agent-fixtures';
const hooks=vi.hoisted(()=>{
    let cursor=0;const slots:Array<{value?:unknown;deps?:unknown[];cleanup?:()=>void}>=[],effects:Array<()=>void>=[];
    const same=(a:unknown[]|undefined,b:unknown[])=>a?.length===b.length&&b.every((value,index)=>Object.is(value,a[index]));
    return {begin:()=>{cursor=0;},commit:()=>effects.splice(0).forEach(effect=>effect()),dispose:()=>{slots.splice(0).forEach(slot=>slot.cleanup?.());effects.length=0;},
        useState:(initial:unknown)=>{const slot=slots[cursor++]??={value:initial};return[slot.value,(value:unknown)=>{slot.value=value;}];},
        useRef:(initial:unknown)=>(slots[cursor++]??={value:{current:initial}}).value,
        useCallback:(value:unknown,deps:unknown[])=>{const index=cursor++,previous=slots[index];if(previous&&same(previous.deps,deps))return previous.value;slots[index]={value,deps};return value;},
        useEffect:(effect:()=>void|(()=>void),deps:unknown[])=>{const index=cursor++,previous=slots[index];if(previous&&same(previous.deps,deps))return;const slot=slots[index]={deps};effects.push(()=>{previous?.cleanup?.();slot.cleanup=effect()||undefined;});},
    };
});
const ui=vi.hoisted(()=>({owner:'admin',project:'project-one' as string|undefined,sectionRefresh:undefined as (()=>void)|undefined,owners:new Map<string,()=>()=>boolean>()}));
vi.mock('react',()=>hooks);
vi.mock('../src/features/UserBlock/useAuthRequestOwner',()=>({useAuthRequestOwner:()=>{
    const scope=ui.owner;let captureOwner=ui.owners.get(scope);if(!captureOwner){captureOwner=()=>()=>scope===ui.owner;ui.owners.set(scope,captureOwner);}return{scope,captureOwner};
}}));
vi.mock('../src/core/socket/useSectionUpdates',()=>({useSectionUpdates:(_sections:unknown,refresh:()=>void)=>{ui.sectionRefresh=refresh;}}));
vi.mock('../src/features/AgentCatalog/api',()=>({agentCatalogApi:{list:vi.fn()}}));
function render(){hooks.begin();const result=useAgentCatalog(ui.project);hooks.commit();return result;}
async function settle(){for(let n=0;n<15;n++)await Promise.resolve();return render();}
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return{promise,resolve};}
beforeEach(()=>{
    vi.useFakeTimers();vi.clearAllMocks();ui.owner='admin';ui.project='project-one';ui.owners.clear();
    vi.stubGlobal('window',{setInterval,clearInterval});vi.stubGlobal('document',{visibilityState:'visible'});vi.mocked(agentCatalogApi.list).mockResolvedValue(catalog());
});
afterEach(()=>{hooks.dispose();vi.unstubAllGlobals();vi.useRealTimers();});
it('GET failure сохраняет предыдущую карточку и явную ошибку вместо пустого успеха',async()=>{
    render();expect((await settle()).catalog).toEqual(catalog());vi.mocked(agentCatalogApi.list).mockRejectedValueOnce(new Error('Нет сети'));await render().refresh();
    expect(render()).toMatchObject({catalog:catalog(),loading:false});expect(render().error).toBeTruthy();
});
it('Более поздний GET выигрывает, даже если старый ответ пришёл последним',async()=>{
    const old=deferred<ReturnType<typeof catalog>>();vi.mocked(agentCatalogApi.list).mockReturnValueOnce(old.promise);render();
    vi.mocked(agentCatalogApi.list).mockResolvedValueOnce(catalog({revision:7}));await render().refresh();old.resolve(catalog({revision:2}));await settle();expect(render().catalog?.revision).toBe(7);
});
it.each(['project','owner'])('Late response прежнего %s не раскрывает текущему владельцу старые prompts',async change=>{
    const old=deferred<ReturnType<typeof catalog>>();vi.mocked(agentCatalogApi.list).mockReturnValueOnce(old.promise);render();if(change==='owner')ui.owner='reader';else ui.project='project-two';
    render();await settle();old.resolve(catalog({revision:99}));await settle();expect(render().catalog?.revision).toBe(3);expect(agentCatalogApi.list).toHaveBeenLastCalledWith(ui.project);
});
it('Pending current revision перечитывается до terminal receipt; старые queued revisions не крутят polling',async()=>{
    vi.mocked(agentCatalogApi.list).mockResolvedValueOnce(catalog({deliveries:[delivery({state:'queued',result:null})]}));render();await settle();
    vi.mocked(agentCatalogApi.list).mockResolvedValue(catalog({deliveries:[delivery()]}));await vi.advanceTimersByTimeAsync(3000);await settle();expect(agentCatalogApi.list).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(6000);expect(agentCatalogApi.list).toHaveBeenCalledTimes(2);
    vi.mocked(agentCatalogApi.list).mockResolvedValue(catalog({revision:4,deliveries:[delivery({state:'queued',revision:3,result:null})]}));await render().refresh();render();const calls=vi.mocked(agentCatalogApi.list).mock.calls.length;
    await vi.advanceTimersByTimeAsync(6000);expect(agentCatalogApi.list).toHaveBeenCalledTimes(calls);
});
it('Socket invalidation перечитывает данные, malformed response не стирает assignments',async()=>{
    render();await settle();vi.mocked(agentCatalogApi.list).mockResolvedValueOnce({items:[]} as ReturnType<typeof catalog>);ui.sectionRefresh!();await settle();expect(render().catalog).toEqual(catalog());expect(render().error).toContain('неполный');
});
