// @vitest-environment jsdom
import {act,createElement} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {Router} from 'react-router-dom';
import {createMemoryHistory} from 'history';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {useOperationDeepLink} from '../src/modules/Operations/useOperationDeepLink';
import {useOperationsQueue} from '../src/modules/Operations/useOperationsQueue';
import type {RootState} from '../src/store';
import type {IUserBlockState} from '../src/features/UserBlock/interfaces';

const h=vi.hoisted(()=>({read:vi.fn(),detail:vi.fn(),userBlock:{} as IUserBlockState}));
vi.mock('../src/core/api/bff',()=>({default:{listOperations:(...args:unknown[])=>h.read(...args),getOperation:(...args:unknown[])=>h.detail(...args)}}));
vi.mock('react-redux',()=>({useSelector:(select:(state:RootState)=>unknown)=>select({userBlock:h.userBlock} as RootState)}));
vi.mock('../src/core/socket/useSectionUpdates',()=>({useSectionUpdates:()=>undefined}));
vi.mock('../src/features/TabNotifications/useTabWatch',()=>({useTabWatch:()=>undefined}));
const id='tool-build-11111111-2222-4333-8444-555555555555';
let root:Root,container:HTMLDivElement,history:ReturnType<typeof createMemoryHistory>;
let queue:ReturnType<typeof useOperationsQueue>,link:ReturnType<typeof useOperationDeepLink>;
function Probe(){queue=useOperationsQueue();link=useOperationDeepLink(queue.select,true);return createElement('div',null,link.error||queue.detailError||queue.selected?.operationId);}
const render=async()=>{await act(async()=>{root.render(createElement(Router,{history},createElement(Probe)));});};
beforeEach(()=>{
    vi.resetAllMocks();vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
    h.userBlock={isAuth:true,processing:false,error:'',authorizationUnconfirmed:false,request:null,policies:{},user:{id:'qa',principalName:'qa',email:'qa@example.test',displayName:'QA',activeRole:'Наблюдатель',userRoles:['Наблюдатель'],routePermissions:[],projectRoles:[]}};
    h.read.mockResolvedValue({items:[],total:0,page:1,size:10,activeCount:0});
    history=createMemoryHistory({initialEntries:['/projects?operations=open&operation='+id]});
    container=document.createElement('div');document.body.appendChild(container);root=createRoot(container);
});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();vi.unstubAllGlobals();});
it('opens the exact operation once and removes only its query parameter on close',async()=>{
    h.detail.mockResolvedValue({operationId:id});await render();await render();
    expect(h.detail).toHaveBeenCalledTimes(1);expect(h.detail).toHaveBeenCalledWith(id);expect(container.textContent).toBe(id);
    await act(async()=>{queue.close();link.clear();});expect(history.location.search).toBe('?operations=open');expect(queue.selectedId).toBe('');expect(h.detail).toHaveBeenCalledTimes(1);
});
it('reports an unknown operation and allows the existing explicit detail refresh',async()=>{
    h.detail.mockRejectedValue({isAxiosError:true,response:{status:404,data:{message:'Операция не найдена'}}});await render();
    expect(queue.detailError).toBe('Операция не найдена');expect(queue.selected).toBeNull();
    h.detail.mockResolvedValue({operationId:id});await act(async()=>{await queue.refreshDetail();});expect(container.textContent).toBe(id);
});
it('rejects malformed route IDs without a detail request',async()=>{
    history.replace('/projects?operations=open&operation=..%2Fsecret');await render();expect(h.detail).not.toHaveBeenCalled();expect(container.textContent).toContain('Ссылка на операцию некорректна');
});
it('discards a late response after auth changes and rechecks the current access',async()=>{
    let finish:(value:unknown)=>void=()=>undefined;h.detail.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));await render();
    h.userBlock={...h.userBlock,user:{...h.userBlock.user!,email:'next@example.test'}};h.detail.mockRejectedValueOnce({isAxiosError:true,response:{status:403,data:{message:'Нет доступа'}}});await render();
    await act(async()=>{finish({operationId:id});});expect(queue.selected).toBeNull();expect(container.textContent).toContain('Нет доступа');expect(h.detail).toHaveBeenCalledTimes(2);
});
