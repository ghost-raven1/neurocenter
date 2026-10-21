import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {useCatalogRequests} from '../src/features/CatalogRequests/useCatalogRequests';
import {catalogRequestsApi} from '../src/features/CatalogRequests/api';
import type {IRequestFilters} from '../src/features/CatalogRequests/types';
import {catalogRequest} from './catalog-request-fixtures';
const hooks=vi.hoisted(()=>{
    let cursor=0;const slots:Array<{value?:unknown;deps?:unknown[];cleanup?:()=>void}>=[],effects:Array<()=>void>=[];
    const same=(a:unknown[]|undefined,b:unknown[])=>a?.length===b.length&&b.every((value,index)=>Object.is(value,a[index]));
    return {begin:()=>{cursor=0;},commit:()=>effects.splice(0).forEach(effect=>effect()),dispose:()=>{slots.splice(0).forEach(slot=>slot.cleanup?.());effects.length=0;},
        useState<T>(initial:T){const slot=slots[cursor++]??={value:initial};return[slot.value,(next:T|((old:T)=>T))=>{slot.value=typeof next==='function'?(next as (old:T)=>T)(slot.value as T):next;}];},
        useRef<T>(initial:T){return(slots[cursor++]??={value:{current:initial}}).value;},
        useCallback<T>(value:T,deps:unknown[]){const index=cursor++,previous=slots[index];if(!previous||!same(previous.deps,deps))slots[index]={value,deps};return slots[index].value;},
        useEffect(effect:()=>void|(()=>void),deps:unknown[]){const index=cursor++,previous=slots[index];if(previous&&same(previous.deps,deps))return;const slot=slots[index]={deps};effects.push(()=>{previous?.cleanup?.();slot.cleanup=effect()||undefined;});},
    };
});
const ui=vi.hoisted(()=>({owner:'author',epoch:0,owners:new Map<string,()=>()=>boolean>(),reload:undefined as (()=>void)|undefined,sections:[] as string[]}));
vi.mock('react',()=>hooks);
vi.mock('../src/features/UserBlock/useAuthRequestOwner',()=>({useAuthRequestOwner:()=>{
    const owner=ui.owner,epoch=ui.epoch,key=owner+':'+epoch;let captureOwner=ui.owners.get(key);if(!captureOwner){captureOwner=()=>()=>owner===ui.owner&&epoch===ui.epoch;ui.owners.set(key,captureOwner);}return {scope:owner,captureOwner};
}}));
vi.mock('../src/core/socket/useSectionUpdates',()=>({useSectionUpdates:(sections:string[],refresh:()=>void)=>{ui.sections=sections;ui.reload=refresh;}}));
vi.mock('../src/features/CatalogRequests/api',()=>({catalogRequestsApi:{list:vi.fn()}}));
let filters:IRequestFilters;
const page=(title='Заявка')=>({items:[catalogRequest({title})],total:1,page:filters.page,size:20});
function render(){hooks.begin();const view=useCatalogRequests(filters);hooks.commit();return view;}
async function settle(){for(let i=0;i<15;i++)await Promise.resolve();return render();}
function deferred<T>(){let resolve!:(value:T)=>void;let reject!:(value:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
beforeEach(()=>{vi.clearAllMocks();ui.owner='author';ui.epoch=0;ui.owners.clear();filters={scope:'mine',page:1,size:20};vi.mocked(catalogRequestsApi.list).mockImplementation(async()=>page());});
afterEach(()=>hooks.dispose());
describe('Очередь принадлежит текущим правам и фильтрам',()=>{
    it('Transient failure retains queue with explicit error; a later retry recovers',async()=>{
        render();await settle();vi.mocked(catalogRequestsApi.list).mockRejectedValueOnce(new Error('Нет сети'));await render().refresh();expect(render().page?.items[0].title).toBe('Заявка');expect(render().error).toBe('Нет сети');
        await render().refresh();expect(render().error).toBe('');
    });
    it.each([401,403])('Explicit%i removes private queued items immediately',async status=>{
        render();await settle();vi.mocked(catalogRequestsApi.list).mockRejectedValueOnce({isAxiosError:true,response:{status,data:{message:'Нет доступа'}}});await render().refresh();expect(render().page).toBeNull();expect(render().accessDenied).toBe(true);expect(render().error).toBe('Нет доступа');
    });
    it('Older GET cannot replace a newer result or its loading state',async()=>{
        const old=deferred<ReturnType<typeof page>>();vi.mocked(catalogRequestsApi.list).mockReturnValueOnce(old.promise);render();vi.mocked(catalogRequestsApi.list).mockResolvedValueOnce(page('Новая'));await render().refresh();old.resolve(page('СТАРАЯ'));await settle();expect(render().page?.items[0].title).toBe('Новая');expect(render().loading).toBe(false);
    });
    it('Project/filter navigation drops a late previous queue',async()=>{
        const old=deferred<ReturnType<typeof page>>();vi.mocked(catalogRequestsApi.list).mockReturnValueOnce(old.promise);render();filters={...filters,scope:'all',projectId:'prj-two',assetType:'model'};vi.mocked(catalogRequestsApi.list).mockResolvedValueOnce(page('Другой проект'));render();await settle();old.resolve(page('ПРИВАТНО'));await settle();expect(render().page?.items[0].title).toBe('Другой проект');expect(catalogRequestsApi.list).toHaveBeenLastCalledWith(filters);
    });
    it('A → B → A access change cannot revive the old callback',async()=>{
        const old=deferred<ReturnType<typeof page>>();vi.mocked(catalogRequestsApi.list).mockReturnValueOnce(old.promise);render();ui.owner='other';ui.epoch++;render();await settle();ui.owner='author';ui.epoch++;vi.mocked(catalogRequestsApi.list).mockResolvedValueOnce(page('Новый доступ'));render();await settle();old.resolve(page('СТАРЫЕ ПРАВА'));await settle();expect(render().page?.items[0].title).toBe('Новый доступ');
    });
    it('Socket invalidation refreshes only the request section, malformed data remains a visible failure',async()=>{
        render();await settle();expect(ui.sections).toEqual(['requests']);vi.mocked(catalogRequestsApi.list).mockResolvedValueOnce({items:[]} as never);ui.reload!();await settle();expect(render().page?.items).toHaveLength(1);expect(render().error).toContain('неполный');
    });
});
