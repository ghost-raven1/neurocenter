// @vitest-environment jsdom
import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {BundledCatalogSources} from '../src/features/AssetSources/BundledCatalogSources';
import type {StoredBuildDraft} from '../src/modules/Store/packaging/buildDraftStore';

const io=vi.hoisted(()=>({submit:vi.fn(),lookup:vi.fn(),preview:vi.fn(),scope:'owner-a',enabled:true,plansReady:true,prepareId:undefined as string|undefined,draft:undefined as StoredBuildDraft|undefined}));
const capture=()=>{const owner=io.scope;return()=>io.scope===owner;};
vi.mock('../src/features/UserBlock/useAuthRequestOwner',()=>({useAuthRequestOwner:()=>({captureOwner:capture})}));
vi.mock('../src/modules/Store/packaging/api',()=>({packagingApi:{publicationConflict:io.lookup,publicationTarget:io.preview}}));
vi.mock('../src/modules/Store/packaging/useToolBuild',()=>({useToolBuild:()=>({recovering:false,active:false,archived:[],submit:io.submit,draft:io.draft})}));
vi.mock('../src/features/FeatureFlags/FeatureAvailability',()=>({useFeatureAvailability:()=>({enabled:io.enabled,known:true}),FeatureButton:({features:_,...props}:any)=><button {...props}/>}));
vi.mock('antd',async()=>{
    const actual=await vi.importActual<typeof import('antd')>('antd');
    const Box=({children}:any)=><div>{children}</div>;
    return {Alert:({message,description,action}:any)=><div role="alert">{message}{description}{action}</div>,Button:({loading:_,type:__,...props}:any)=><button {...props}/>,Card:Box,
        Form:Object.assign(Box,{Item:Box}),Select:actual.Select,Progress:Box,Input:(props:any)=><input {...props}/>,Modal:({open,children,footer}:any)=>open?<div>{children}{footer}</div>:null,Space:Box,Tag:Box,Typography:{Text:Box,Title:Box,Paragraph:Box}};
});
const plan={id:'source-tool',kind:'mcp' as const,name:'Tool',description:'Source',sourceRevision:'current',revision:'a'.repeat(64),delivery:'prepared' as const};
const conflict={catalogId:'existing-tool',kind:'mcp',name:'Tool',archived:false};
const preview={...conflict,expectedVersion:3,expectedSourceHash:'b'.repeat(64),description:'Old source',sourceSummaries:[],updateSupported:true};
let root:Root,host:HTMLDivElement;
const render=()=>act(async()=>root.render(<BundledCatalogSources plans={io.plansReady?[plan]:[]} plansReady={io.plansReady} scope={io.scope} blocked={false} prepareId={io.prepareId} onPublished={()=>{}} onImportArchive={()=>{}}/>));
const button=(label:string)=>[...host.querySelectorAll('button')].find(value=>value.textContent===label)!;
const click=(label:string)=>act(async()=>{expect(button(label)).toBeDefined();button(label).click();});
beforeEach(async()=>{vi.clearAllMocks();io.scope='owner-a';io.enabled=true;io.plansReady=true;io.prepareId=undefined;io.draft=undefined;io.lookup.mockResolvedValue(conflict);io.preview.mockResolvedValue(preview);vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);host=document.createElement('div');document.body.append(host);root=createRoot(host);await render();await click('Подготовить пакет');});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();});

it('Offers the existing version without posting or discarding the bundled source, then sends explicit CAS consent',async()=>{
    await click('Подготовить и опубликовать');expect(io.submit).not.toHaveBeenCalled();
    expect(io.preview).toHaveBeenCalledWith({catalogId:'existing-tool',kind:'mcp'},expect.any(AbortSignal));
    await click('Подготовить новую версию');await click('Подготовить и опубликовать');
    expect(io.submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({name:'Tool',source:{type:'bundled',id:plan.id,revision:plan.revision},publication:{catalogId:'existing-tool',expectedVersion:3,expectedSourceHash:'b'.repeat(64)}}));
});
it.each([{...conflict,kind:'plugin'},{...conflict,archived:true}])('Does not offer an incompatible or archived target: %j',async value=>{
    io.lookup.mockResolvedValue(value);await click('Подготовить и опубликовать');expect(io.submit).not.toHaveBeenCalled();expect(io.preview).not.toHaveBeenCalled();expect(host.textContent).toContain('другое название');expect(host.querySelector('input')?.value).toBe('Tool');
});
it('Lookup failure preserves the form and permits a safe retry',async()=>{
    io.lookup.mockRejectedValueOnce(new Error('Offline'));await click('Подготовить и опубликовать');expect(io.submit).not.toHaveBeenCalled();expect(host.textContent).toContain('Offline');expect(host.querySelector('input')?.value).toBe('Tool');
    io.lookup.mockResolvedValue(null);await click('Подготовить и опубликовать');expect(io.submit).toHaveBeenCalledOnce();
});
it('A late available-name response after owner change cannot start a build',async()=>{
    let resolve!:(value:null)=>void;io.lookup.mockReturnValue(new Promise(done=>{resolve=done;}));await click('Подготовить и опубликовать');io.scope='owner-b';await render();await act(async()=>resolve(null));expect(io.submit).not.toHaveBeenCalled();
});
it('Refreshing the target invalidates consent until the new head is confirmed',async()=>{
    await click('Подготовить и опубликовать');await click('Подготовить новую версию');io.preview.mockResolvedValue({...preview,expectedVersion:4,expectedSourceHash:'c'.repeat(64)});
    await click('Обновить цель');expect(button('Подготовить и опубликовать').disabled).toBe(true);await click('Подготовить новую версию');await click('Подготовить и опубликовать');expect(io.submit).toHaveBeenCalledWith(expect.objectContaining({publication:expect.objectContaining({expectedVersion:4,expectedSourceHash:'c'.repeat(64)})}));
});
it('A disabled feature invalidates a pending name check',async()=>{
    let resolve!:(value:null)=>void;io.lookup.mockReturnValue(new Promise(done=>{resolve=done;}));await click('Подготовить и опубликовать');io.enabled=false;await render();await act(async()=>resolve(null));expect(io.submit).not.toHaveBeenCalled();
});
it('A prepare link opens the chosen source once without creating a build',async()=>{
    await click('Скрыть');io.prepareId=plan.id;await render();expect(button('Подготовить и опубликовать')).toBeDefined();expect(io.submit).not.toHaveBeenCalled();expect(io.lookup).not.toHaveBeenCalled();
    await click('Скрыть');await render();expect(button('Подготовить и опубликовать')).toBeUndefined();
});
it('An unknown prepare link explains the refusal without opening or submitting',async()=>{
    await click('Скрыть');io.prepareId='unknown';await render();expect(button('Подготовить и опубликовать')).toBeUndefined();expect(host.textContent).toContain('сейчас нельзя подготовить');expect(io.submit).not.toHaveBeenCalled();
});
it('A cold-load prepare link waits for source plans before opening',async()=>{
    await click('Скрыть');io.plansReady=false;io.prepareId=plan.id;await render();expect(button('Подготовить и опубликовать')).toBeUndefined();
    io.plansReady=true;await render();expect(button('Подготовить и опубликовать')).toBeDefined();expect(io.submit).not.toHaveBeenCalled();
});
it('The real platform selector retains the selected target through conflict preview and consent',async()=>{
    await act(async()=>{host.querySelector('.ant-select-selector')!.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));});
    const option=document.querySelector<HTMLElement>('.ant-select-item-option[title="macOS · Apple Silicon"]');expect(option).not.toBeNull();
    await act(async()=>option!.click());
    expect(host.querySelector('.ant-select-selection-item')?.textContent).toContain('macOS · Apple Silicon');
    await click('Подготовить и опубликовать');expect(io.submit).not.toHaveBeenCalled();
    expect(host.querySelector('.ant-select-selection-item')?.textContent).toContain('macOS · Apple Silicon');
    await click('Подготовить новую версию');await click('Подготовить и опубликовать');
    expect(io.submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({targets:['darwin-arm64'],source:{type:'bundled',id:plan.id,revision:plan.revision},publication:expect.objectContaining({catalogId:'existing-tool',expectedVersion:3})}));
});
it('A prepare link resumes the retained draft instead of looking up or submitting the linked source',async()=>{
    await click('Скрыть');
    io.draft={schemaVersion:1,scope:'owner-a:bundled-catalog',request:{requestKey:'11111111-1111-4111-8111-111111111111',kind:'mcp',name:'Already retained build',description:'Retained source',targets:['linux-x64-glibc'],source:{type:'bundled',id:'older-source',revision:'d'.repeat(64)}}};
    const retained=structuredClone(io.draft);io.prepareId=plan.id;await render();
    expect(host.querySelector('[role="status"]')?.textContent).toContain('Already retained build');
    expect(button('Подготовить и опубликовать')).toBeUndefined();expect(io.lookup).not.toHaveBeenCalled();expect(io.preview).not.toHaveBeenCalled();expect(io.submit).not.toHaveBeenCalled();
    expect(io.draft).toEqual(retained);
});
