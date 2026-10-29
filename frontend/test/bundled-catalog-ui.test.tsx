import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {IDBFactory} from 'fake-indexeddb';
import {BundledCatalogSources} from '../src/features/AssetSources/BundledCatalogSources';
import {readImportIntent} from '../src/features/AssetSources/types';
import {readStoredBuildDraft,saveStoredBuildDraft} from '../src/modules/Store/packaging/buildDraftStore';
import type {IBundledSourcePlan} from '../src/features/AssetSources/types';
import type {ToolBuildRequest} from '../src/modules/Store/packaging/types';
const capture=()=>()=>true;
const state=vi.hoisted(()=>({job:undefined as {id:string;state:string}|undefined}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner',()=>({useAuthRequestOwner:()=>({captureOwner:capture})}));
vi.mock('../src/modules/Store/packaging/useToolBuild',()=>({useToolBuild:()=>({recovering:false,active:false,archived:[],job:state.job})}));
vi.mock('../src/modules/Store/packaging/usePackagingPublication',()=>({usePackagingPublication:()=>({blocked:false})}));
const plan:IBundledSourcePlan={id:'plugin-opencode-rag-plugin',kind:'plugin',name:'OpenCodeRAG',description:'Текущий RAG',sourceRevision:'2.12.2-plugin.pack.1',revision:'a'.repeat(64),delivery:'prepared',
    imported:{id:'native-rag',version:4,originVersion:'build-old',updateAvailable:false}};
const view=(plans:IBundledSourcePlan[])=>renderToStaticMarkup(createElement(BundledCatalogSources,{plans,scope:'main-owner',blocked:false,onPublished:vi.fn(),onImportArchive:vi.fn()}));
beforeEach(()=>{state.job=undefined;vi.stubGlobal('indexedDB',new IDBFactory());});
afterEach(()=>vi.unstubAllGlobals());
describe('Current source is distinct from catalog publication and computer installation',()=>{
    it('Shows exact approved source and old catalog receipt before the explicit preparation action',()=>{
        const html=view([plan]);expect(html).toContain('Исходники 2.12.2-plugin.pack.1');expect(html).toContain('редакция 4');expect(html).toContain('build-old');
        expect(html).toContain('Подготовить обновление');expect(html).not.toContain('Пакет этой версии опубликован');expect(html).not.toContain('Установлено');
    });
    it('Only confirmed catalog readiness replaces the update proposal; model and bridge metadata never offers automatic preparation',()=>{
        const ready=view([{...plan,catalogReady:true}]);expect(ready).toContain('Пакет этой версии опубликован');expect(ready).not.toContain('Подготовить обновление');expect(ready).not.toContain('Установлено');
        const manual=view([{...plan,id:'model-test',kind:'model',delivery:'model-archive'},{...plan,id:'bridge-test',kind:'bridge',sourceRevision:'application',delivery:'app-bridge'}]);
        expect(manual).toContain('Веса добавляются выбранным GGUF');expect(manual).not.toContain('Подготовить обновление');
    });
    it('A saved bundled source preserves UUID, exact revision, target consent and publication CAS across reload and owner changes',async()=>{
        const request:ToolBuildRequest={requestKey:'11111111-1111-4111-8111-111111111111',kind:'plugin',name:'Мой RAG',description:'Текущий RAG',source:{type:'bundled',id:plan.id,revision:plan.revision},targets:['darwin-arm64'],
            publication:{catalogId:'native-rag',expectedVersion:4,expectedSourceHash:'b'.repeat(64)}};
        await saveStoredBuildDraft('alice-main:bundled-catalog',request);expect((await readStoredBuildDraft('alice-main:bundled-catalog'))?.request).toEqual(request);
        await expect(saveStoredBuildDraft('alice-main:bundled-catalog',{...request,source:{...request.source,revision:'c'.repeat(64)}} as ToolBuildRequest)).rejects.toThrow();
        expect(await readStoredBuildDraft('bob-main:bundled-catalog')).toBeUndefined();expect(await readStoredBuildDraft('alice-dev:bundled-catalog')).toBeUndefined();
    });
    it('Content-based source import recovery preserves the SHA identity and still rejects malformed commits',()=>{
        const saved={requestKey:'11111111-1111-4111-8111-111111111111',commit:'sha256:'+'a'.repeat(64),ids:['agent-reviewer']};
        expect(readImportIntent(JSON.stringify(saved))).toMatchObject(saved);expect(readImportIntent(JSON.stringify({...saved,commit:'sha256:bad'}))).toBeUndefined();
    });
    it('An accepted build remains reachable when the current recipe list is unavailable',()=>{
        state.job={id:'11111111-1111-4111-8111-111111111111',state:'FAILED'};
        const html=view([]);expect(html).toContain('Продолжить подготовку каталога');expect(html).not.toContain('Подготовить пакет');
    });
});
