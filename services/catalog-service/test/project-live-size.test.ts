import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import http from 'node:http';
import type {AddressInfo} from 'node:net';
import {CatalogService} from '../src/catalog/catalog.service';
import {measureProjectDataSize} from '../src/catalog/fs-metrics';

const fixture=vi.hoisted(()=>({getProject:vi.fn(),listProjects:vi.fn()}));
vi.mock('../src/catalog/catalog-db',()=>({CatalogDb:class{
    getProject=fixture.getProject;listProjects=fixture.listProjects;
}}));
vi.mock('../src/catalog/fs-metrics',()=>({measureProjectDataSize:vi.fn(async()=>0)}));
const project=()=>({id:'prj-own',name:'own',logicalBytes:123,retainedBytes:456,fsRootPath:'',quota:{currentBytesUsed:123,retentionBytesUsed:456}});
let server:http.Server|undefined;const previous=process.env.RAG_SERVICE_URL;
beforeEach(()=>{vi.mocked(measureProjectDataSize).mockResolvedValue(0);fixture.getProject.mockReset().mockResolvedValue(project());fixture.listProjects.mockReset().mockImplementation(async()=>({items:[project()],page:1,size:10,total:1}));});
afterEach(async()=>{if(server){server.closeAllConnections();await new Promise<void>(resolve=>server!.close(()=>resolve()));server=undefined;}if(previous===undefined)delete process.env.RAG_SERVICE_URL;else process.env.RAG_SERVICE_URL=previous;});
async function rag(handler:http.RequestListener):Promise<void>{server=http.createServer(handler);await new Promise<void>(resolve=>server!.listen(0,'127.0.0.1',resolve));process.env.RAG_SERVICE_URL='http://127.0.0.1:'+(server.address() as AddressInfo).port;}

describe('Живой размер проекта не подменяет ошибку нулём',()=>{
    it('Нет RAG конфигурации: проект и список доступны, размер и вложенный счётчик неизвестны',async()=>{
        delete process.env.RAG_SERVICE_URL;const service=new CatalogService();
        const detail=await service.getProject('prj-own');expect(detail.retainedBytes).toBeNull();
        expect(detail.quota.retentionBytesUsed).toBeNull();expect(detail).toMatchObject({id:'prj-own',name:'own'});
        expect((await service.listProjects(1,10,'')).items[0].retainedBytes).toBeNull();
    });
    it.each(['503','bad-json','missing','string','negative','unsafe','foreign'])('Отказ или некорректный ответ %s не становится bytes0',async mode=>{
        await rag((_req,res)=>{
            if(mode==='503'){res.writeHead(503).end('Не выводить upstream details');return;}
            if(mode==='bad-json'){res.end('{broken');return;}
            const bytes=mode==='string'?'42':mode==='negative'?-1:mode==='unsafe'?Number.MAX_SAFE_INTEGER+1:42;
            res.end(JSON.stringify({projectKey:mode==='foreign'?'prj-foreign':'prj-own',...(mode==='missing'?{}:{bytes})}));
        });
        const detail=await new CatalogService().getProject('prj-own');expect(detail.retainedBytes).toBeNull();
        expect(detail.quota.retentionBytesUsed).toBeNull();expect(detail).toMatchObject({id:'prj-own'});
    });
    it('Подтверждённый пустой индекс остаётся нулём, здоровый повтор возвращает число',async()=>{
        let bytes=0;await rag((_req,res)=>res.end(JSON.stringify({projectKey:'prj-own',bytes})));
        const service=new CatalogService();expect((await service.getProject('prj-own')).retainedBytes).toBe(0);
        bytes=8192;expect((await service.getProject('prj-own')).retainedBytes).toBe(8192);
    });
    it('Неизвестный локальный размер и причина восстанавливаются на том же объекте после повтора',async()=>{
        delete process.env.RAG_SERVICE_URL;
        vi.mocked(measureProjectDataSize).mockResolvedValueOnce(null).mockResolvedValueOnce(11);
        const service=new CatalogService();
        const first=await service.getProject('prj-own');
        expect(first.logicalBytes).toBeNull();expect(first.quota.currentBytesUsed).toBeNull();
        expect(first.logicalSizeError).toBeTruthy();
        const next=await service.getProject('prj-own');
        expect(next.logicalBytes).toBe(11);expect(next.quota.currentBytesUsed).toBe(11);
        expect(next.logicalSizeError).toBeUndefined();
    });
    it('Отказ копии знаний не ломает известный локальный размер; повтор убирает старую причину',async()=>{
        let unavailable=true;await rag((_req,res)=>{
            if(unavailable)res.writeHead(503).end('secret');else res.end(JSON.stringify({projectKey:'prj-own',bytes:0}));
        });
        const service=new CatalogService(),first=await service.getProject('prj-own');
        expect(first.logicalBytes).toBe(0);expect(first.retainedSizeError).toBeTruthy();
        expect(first.retainedSizeError).not.toContain('secret');
        unavailable=false;const next=await service.getProject('prj-own');
        expect(next.retainedBytes).toBe(0);expect(next.quota.retentionBytesUsed).toBe(0);
        expect(next.retainedSizeError).toBeUndefined();
    });
});
