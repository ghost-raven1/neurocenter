// @vitest-environment jsdom
import {act,createElement} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {Provider} from 'react-redux';
import {configureStore} from '@reduxjs/toolkit';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {RootState} from '../src/store';
import type {ICatalogRebuild,ISourceList} from '../src/features/AssetSources/types';
import {useCatalogSourceStatus} from '../src/features/AssetSources/useCatalogSourceStatus';
import {CATALOG_REBUILD_POLL_LIMIT,CATALOG_REBUILD_POLL_MS} from '../src/features/AssetSources/catalogSourceStatus';

const io=vi.hoisted(()=>({get:vi.fn(),post:vi.fn()}));
vi.mock('../src/core/api',()=>({baseApi:{get:io.get,post:io.post}}));
const snapshot=(id='main-a',role='Главный админ')=>({userBlock:{user:{id,email:id+'@example.test',displayName:id,activeRole:role,userRoles:[role],projectRoles:[],routePermissions:['store','assets','operations']},policies:{}}}) as RootState;
const reducer=(state=snapshot(),action:{type:string;payload?:RootState}):RootState=>action.type==='auth/change'?action.payload!:state;
const source=(name='current',rebuild?:ICatalogRebuild):{data:ISourceList}=>({data:{source:{repository:name,verified:true,mode:'bundled'},assets:[],rebuild}});
const rebuild=(state:ICatalogRebuild['state']='preparing'):ICatalogRebuild=>({requestId:'request-one',sourceRevision:'a'.repeat(64),requestedAt:'2026-10-30T00:00:00.000Z',updatedAt:'2026-10-30T00:01:00.000Z',state,
    items:[{id:'rag',name:'OpenCodeRAG',state:state==='preparing'?'pending':state==='ready'?'ready':'attention',message:'Результат подготовки'}]});
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>{resolve=yes;});return{promise,resolve};}
let root:Root,container:HTMLDivElement,store:ReturnType<typeof configureStore<RootState>>;
let refresh:()=>Promise<void>;
function Probe({context}:{context:string}){
    const status=useCatalogSourceStatus(context);refresh=status.refresh;
    return createElement('div',null,status.data?.source.repository,status.data?.rebuild?.state,status.error);
}
const render=async(context='project-a')=>{await act(async()=>{root.render(createElement(Provider,{store},createElement(Probe,{context})));});};
const settle=async()=>{await act(async()=>{await Promise.resolve();});};
beforeEach(()=>{
    vi.useFakeTimers();vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);io.get.mockReset();io.post.mockReset();io.get.mockResolvedValue(source());
    store=configureStore({reducer});container=document.createElement('div');document.body.appendChild(container);root=createRoot(container);
});
afterEach(async()=>{await act(async()=>{root.unmount();});container.remove();vi.useRealTimers();vi.unstubAllGlobals();});

describe('Main-only источник принадлежит текущим правам и проектному контексту',()=>{
    it('does not fetch for a non-Main active role or an ungranted Main role',async()=>{
        store.dispatch({type:'auth/change',payload:snapshot('reader','Наблюдатель')});await render();expect(io.get).not.toHaveBeenCalled();
        const invalid=snapshot();invalid.userBlock.user!.userRoles=['Наблюдатель'];await act(async()=>{store.dispatch({type:'auth/change',payload:invalid});});
        expect(io.get).not.toHaveBeenCalled();expect(container.textContent).toBe('');
    });
    it.each(['before-cleanup','after-cleanup'])('a late Main response is hidden after role loss %s even when the server ignores abort',async timing=>{
        const old=deferred<ReturnType<typeof source>>();io.get.mockReturnValueOnce(old.promise);await render();
        const signal=io.get.mock.calls[0][1].signal as AbortSignal;
        await act(async()=>{store.dispatch({type:'auth/change',payload:snapshot('main-a','Разработчик')});if(timing==='before-cleanup')old.resolve(source('private-main-source',rebuild()));});
        if(timing==='after-cleanup'){expect(signal.aborted).toBe(true);old.resolve(source('private-main-source',rebuild()));await settle();}
        expect(container.textContent).not.toContain('private-main-source');expect(io.get).toHaveBeenCalledOnce();
        await act(async()=>{await vi.advanceTimersByTimeAsync(CATALOG_REBUILD_POLL_MS*3);});expect(io.get).toHaveBeenCalledOnce();expect(io.post).not.toHaveBeenCalled();
    });
    it('context and account switches cannot republish a delayed previous read',async()=>{
        const old=deferred<ReturnType<typeof source>>();io.get.mockReturnValueOnce(old.promise);await render('project-a');
        io.get.mockResolvedValueOnce(source('project-b-source'));await render('project-b');expect(container.textContent).toContain('project-b-source');
        old.resolve(source('old-project-a'));await settle();expect(container.textContent).not.toContain('old-project-a');
        io.get.mockResolvedValueOnce(source('main-b-source'));await act(async()=>{store.dispatch({type:'auth/change',payload:snapshot('main-b')});});
        expect(container.textContent).toContain('main-b-source');expect(container.textContent).not.toContain('project-b-source');expect(io.post).not.toHaveBeenCalled();
    });
    it('an access refusal clears previously visible source metadata',async()=>{
        await render();expect(container.textContent).toContain('current');io.get.mockRejectedValueOnce({response:{status:403}});
        await act(async()=>{await refresh();});expect(container.textContent).not.toContain('current');expect(container.textContent).toContain('Доступ к исходникам не подтверждён');
    });
    it.each(['ready','attention'] as const)('a readonly %s receipt remains readable without polling or POST',async state=>{
        io.get.mockResolvedValueOnce(source('retained-source',rebuild(state)));await render();expect(container.textContent).toContain(state);
        await act(async()=>{await vi.advanceTimersByTimeAsync(CATALOG_REBUILD_POLL_MS*4);});expect(io.get).toHaveBeenCalledOnce();expect(io.post).not.toHaveBeenCalled();
    });
    it('pending preparation polls only its bounded request window and stops once exhausted',async()=>{
        io.get.mockResolvedValue(source('working',rebuild()));await render();expect(io.get).toHaveBeenCalledOnce();
        for(let index=0;index<CATALOG_REBUILD_POLL_LIMIT;index++)await act(async()=>{await vi.advanceTimersByTimeAsync(CATALOG_REBUILD_POLL_MS);});
        expect(io.get).toHaveBeenCalledTimes(CATALOG_REBUILD_POLL_LIMIT+1);
        await act(async()=>{await vi.advanceTimersByTimeAsync(CATALOG_REBUILD_POLL_MS*10);});expect(io.get).toHaveBeenCalledTimes(CATALOG_REBUILD_POLL_LIMIT+1);expect(io.post).not.toHaveBeenCalled();
    });
    it('a newly created unadmitted request keeps polling until the first pending receipt appears',async()=>{
        io.get.mockResolvedValueOnce(source('waiting-for-admission',{...rebuild(),items:[],message:'Запрос создан; приём ещё не подтверждён.'}))
            .mockResolvedValue(source('pending-receipt',rebuild()));
        await render();expect(container.textContent).toContain('waiting-for-admission');expect(io.get).toHaveBeenCalledOnce();
        await act(async()=>{await vi.advanceTimersByTimeAsync(CATALOG_REBUILD_POLL_MS);});
        expect(container.textContent).toContain('pending-receipt');expect(io.get).toHaveBeenCalledTimes(2);expect(io.post).not.toHaveBeenCalled();
    });
    it('a final ready reply cancels the pending polling window',async()=>{
        io.get.mockResolvedValueOnce(source('working',rebuild())).mockResolvedValueOnce(source('published',rebuild('ready')));await render();
        await act(async()=>{await vi.advanceTimersByTimeAsync(CATALOG_REBUILD_POLL_MS);});expect(container.textContent).toContain('ready');
        await act(async()=>{await vi.advanceTimersByTimeAsync(CATALOG_REBUILD_POLL_MS*10);});expect(io.get).toHaveBeenCalledTimes(2);expect(io.post).not.toHaveBeenCalled();
    });
});
