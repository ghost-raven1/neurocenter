import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe,expect,it} from 'vitest';
import {CatalogRebuildStatus} from '../src/features/AssetSources/CatalogRebuildStatus';
import {pendingCatalogSources} from '../src/features/AssetSources/catalogSourceStatus';
import type {IBundledSourcePlan,ICatalogRebuild} from '../src/features/AssetSources/types';
import AppCard from '../src/modules/Store/AppCard';
import {projectCatalogUpdate,showProjectCatalogUpdate} from '../src/modules/Store/projectCatalogUpdates';
import type {IStoreApp} from '../src/features/Catalog/types';
import {CatalogUpdateSummary} from '../src/modules/Store/CatalogUpdateSummary';

const old:IStoreApp={id:'native-rag',name:'OpenCodeRAG',kind:'plugin',version:2,revision:'2.4.4-plugin.pack.11',description:'',origin:'',tags:[]};
const plan:IBundledSourcePlan={id:'opencode-rag-plugin',kind:'plugin',name:'OpenCodeRAG',description:'',sourceRevision:'2.12.2',revision:'a'.repeat(64),delivery:'prepared',catalogReady:false,
    imported:{id:old.id,name:old.name,version:2,originVersion:'2.4.4-plugin.pack.11',updateAvailable:false}};
const rebuild:ICatalogRebuild={requestId:'one',sourceRevision:'a'.repeat(64),requestedAt:'2026-10-30T00:00:00.000Z',updatedAt:'2026-10-30T00:01:00.000Z',state:'preparing',items:[{id:plan.id,name:plan.name,state:'pending',message:'Ожидает подготовки пакета'}]};

describe('Исходники и опубликованный пакет показаны раздельно',()=>{
    it('equal old head/pin does not hide current 2.12.2 source behind a false no-update result',()=>{
        const update=projectCatalogUpdate(old,{common:[old],assets:[{assetId:old.id,assetKind:'plugin',version:2,manifest:'b'.repeat(64),card:old,addedBy:'',addedAt:''}],
            target:{assetId:old.id,assetKind:'plugin',projectId:'one',bindingId:'folder'},installations:[],jobs:[],sourceReady:true,projectReady:true,receiptsReady:true});
        expect(showProjectCatalogUpdate(update)).toBe(false);
        const pending=pendingCatalogSources([plan]);expect(pending.has('plugin:'+old.id)).toBe(true);
        const html=renderToStaticMarkup(createElement(AppCard,{app:old,update,pendingSource:pending.get('plugin:'+old.id),action:null}));
        expect(html).toContain('Доступны исходники 2.12.2; пакет ещё не опубликован.');expect(html).toContain('href="/assets"');
        expect(html).toContain('Поставка 2.4.4-plugin.pack.11');expect(html).not.toContain('Установлено');expect(html).not.toContain('Пакет этой версии опубликован');
        const summary=renderToStaticMarkup(createElement(CatalogUpdateSummary,{catalogCount:0,computerCount:0,sourceCount:1,incomplete:false,onlyUpdates:true,onChange:()=>{}}));
        expect(summary).toContain('Новые исходники: 1');expect(summary).not.toContain('Новых редакций в доступном каталоге нет');
    });
    it('an intent awaiting admission shows waiting explicitly without a fake zero-of-zero result',()=>{
        const html=renderToStaticMarkup(createElement(CatalogRebuildStatus,{rebuild:{...rebuild,items:[],message:'Запрос пересборки создан. Ожидаем проверку прав и приёма пакетов.'}}));
        expect(html).toContain('Ожидаем проверки запроса');expect(html).toContain('<summary>Что дальше</summary>');
        expect(html).toContain('Ожидаем проверку прав и приёма пакетов');expect(html).not.toContain('0 из 0');
        expect(html).not.toContain('Пакеты каталога обновляются');expect(html).not.toContain('Пакеты каталога подготовлены');
    });
    it('an empty attention receipt retains the failure and exposes details without zero-of-zero',()=>{
        const html=renderToStaticMarkup(createElement(CatalogRebuildStatus,{rebuild:{...rebuild,state:'attention',items:[],message:'Результат не подтверждён.'}}));
        expect(html).toContain('Обновление пакетов требует внимания');expect(html).toContain('<summary>Подробности</summary>');
        expect(html).not.toContain('0 из 0');expect(html).not.toContain('Ожидаем проверки запроса');
    });
    it('ready, unknown, archived and non-tool plans do not offer an unpublished tool update',()=>{
        expect(pendingCatalogSources([{...plan,catalogReady:true},{...plan,id:'unknown',catalogReady:undefined},{...plan,id:'archived',imported:{...plan.imported!,archived:true}},
            {...plan,id:'model',kind:'model'},{...plan,id:'bridge',kind:'bridge'}]).size).toBe(0);
    });
    it.each(['preparing','attention','ready'] as const)('one %s receipt retains outcomes and opens recovery without publishing',state=>{
        const html=renderToStaticMarkup(createElement(CatalogRebuildStatus,{rebuild:{...rebuild,state,items:[rebuild.items[0],{id:'model',name:'Модель GGUF',state:'archive-required',message:'Выберите архив'},
            {id:'failed',name:'Пакет MCP',state:'attention',message:'Проверка не пройдена'}]}}));
        expect(html).toContain('href="/operations"');expect(html).toContain('Нужен архив');expect(html).toContain('Проверка не пройдена');expect(html).toContain(state==='attention'?'<details open="">':'<details>');
        expect(html).toContain('href="/assets?archive=open"');expect(html).not.toContain('Установлено');
    });
    it('offers the exact accepted operation instead of starting another preparation',()=>{
        const operationId='11111111-2222-4333-8444-555555555555';
        const html=renderToStaticMarkup(createElement(CatalogRebuildStatus,{plans:[plan],rebuild:{...rebuild,state:'attention',items:[{...rebuild.items[0],state:'attention',operationId}]}}));
        expect(html).toContain('href="/operations?operation=tool-build-'+operationId+'"');expect(html).toContain('Открыть операцию');expect(html).not.toContain('prepare=');
    });
    it('does not invent an operations record for an inline metadata import',()=>{
        const html=renderToStaticMarkup(createElement(CatalogRebuildStatus,{rebuild:{...rebuild,state:'attention',items:[{id:'inline:0',name:'Встроенные агенты',state:'attention',message:'Импорт не завершён',operationId:'11111111-2222-4333-8444-555555555555'}]}}));
        expect(html).not.toContain('operation=');expect(html).toContain('Импорт не завершён');
    });
    it('opens the exact eligible recipe but does not offer preparation for unavailable or published cards',()=>{
        const render=(value:IBundledSourcePlan)=>renderToStaticMarkup(createElement(CatalogRebuildStatus,{plans:[value],rebuild:{...rebuild,state:'attention',items:[{...rebuild.items[0],state:'attention'}]}}));
        expect(render(plan)).toContain('href="/assets?prepare=opencode-rag-plugin"');expect(render(plan)).toContain('Подготовить обновление');
        for(const value of [{...plan,catalogReady:true},{...plan,imported:{...plan.imported!,archived:true}},{...plan,imported:{...plan.imported!,unavailable:true}}])expect(render(value)).not.toContain('prepare=');
    });
});
