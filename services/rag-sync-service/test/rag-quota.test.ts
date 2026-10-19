import {beforeEach,describe,expect,it,vi} from 'vitest';
import type {Request} from 'express';
import {mapRagQuotaError,ragQuotaPolicy,validateRagQuotaUpdate} from '../src/rag/quota/rag-quota';
import {RagController} from '../src/rag/rag.controller';
import {RagService} from '../src/rag/rag.service';
import type {ProjectDatabases} from '../src/rag/project-databases';
import {assertMinLevel} from '../src/rag/role';
vi.mock('../src/rag/role',()=>({assertMinLevel:vi.fn(async()=>undefined)}));

describe('Квоты базы знаний: проверка входных данных',()=>{
    it('Положительные значения по умолчанию и конфигурация оператора',()=>{
        expect(ragQuotaPolicy({})).toEqual({defaultBytes:1024**3,maximumBytes:16*1024**3});
        expect(ragQuotaPolicy({RAG_DEFAULT_QUOTA_BYTES:'1',RAG_MAX_QUOTA_BYTES:'2'})).toEqual({defaultBytes:1,maximumBytes:2});
    });
    it.each(['','0','-1','1.5',' 10','1e3','Infinity','9007199254740992'])('Неверная квота %j останавливает запуск',value=>{
        expect(()=>ragQuotaPolicy({RAG_DEFAULT_QUOTA_BYTES:value})).toThrow();expect(()=>ragQuotaPolicy({RAG_MAX_QUOTA_BYTES:value})).toThrow();
    });
    it('Начальная квота не превышает операторский максимум',()=>{expect(()=>ragQuotaPolicy({RAG_DEFAULT_QUOTA_BYTES:'3',RAG_MAX_QUOTA_BYTES:'2'})).toThrow();});
    it.each([null,[],{},0,{limitBytes:0,expectedRevision:0},{limitBytes:'1',expectedRevision:0},{limitBytes:1,expectedRevision:-1},{limitBytes:1,expectedRevision:0.5},{limitBytes:1},{limitBytes:Number.MAX_SAFE_INTEGER+1,expectedRevision:0}])('Неверное изменение %j не открывает БД',async input=>{
        const withProject=vi.fn();const service=new RagService({withProject} as unknown as ProjectDatabases);
        await expect(service.quota('p',input as never)).rejects.toMatchObject({status:400});expect(withProject).not.toHaveBeenCalled();
    });
    it('Ревизия ноль и точный целый лимит разрешены',()=>{expect(()=>validateRagQuotaUpdate({limitBytes:1,expectedRevision:0})).not.toThrow();});
});
describe('Квоты базы знаний: понятные ошибки',()=>{
    it('Превышение возвращает 413 с действием и сохранёнными деталями объёма',()=>{
        const error=mapRagQuotaError({code:'23514',constraint:'rag_storage_quota_limit',detail:'{"attemptedBytes":101,"limitBytes":100}'});
        expect(error).toMatchObject({status:413,response:{code:'RAG_QUOTA_EXCEEDED',attemptedBytes:101,limitBytes:100,message:expect.stringContaining('попросите администратора')}});
    });
    it.each(['null','[]','invalid','{"attemptedBytes":-1,"limitBytes":"1"}'])('Повреждённые детали %s не скрывают безопасный отказ',detail=>{
        expect(mapRagQuotaError({code:'23514',constraint:'rag_storage_quota_limit',detail})).toMatchObject({status:413,response:{code:'RAG_QUOTA_EXCEEDED'}});
    });
    it.each(['55P03','40P01'])('Конкурентная блокировка %s даёт временную ошибку с повтором',code=>{
        expect(mapRagQuotaError({code})).toMatchObject({status:503,response:{code:'RAG_BUSY',retryAfterSeconds:2}});
    });
    it('Посторонние ошибки PostgreSQL не маскируются переполнением квоты',()=>{
        for(const error of [new Error('connection lost'),{code:'23514',constraint:'other'},null]){expect(mapRagQuotaError(error)).toBe(error);}
    });
});
describe('Квоты базы знаний: роль и автор изменения',()=>{
    const quota=vi.fn(async()=>({limitBytes:100}));const controller=new RagController({quota} as unknown as RagService);
    const req={headers:{'x-bridge-actor':encodeURIComponent(JSON.stringify({email:'admin@example.test'}))}} as unknown as Request;
    beforeEach(()=>vi.clearAllMocks());
    it('Чтение проверяет проект наблюдателя, изменение требует администратора',async()=>{
        await controller.quota(' p ',req);expect(assertMinLevel).toHaveBeenLastCalledWith(req,'p',1);
        await controller.updateQuota({projectKey:' p ',limitBytes:100,expectedRevision:0},req);expect(assertMinLevel).toHaveBeenLastCalledWith(req,'p',3);
    });
    it('Автор берётся из доверенного контекста, тело запроса его не подменяет',async()=>{
        const body={projectKey:'p',limitBytes:100,expectedRevision:0,actor:'attacker@example.test'};
        await controller.updateQuota(body,req);expect(quota).toHaveBeenCalledWith('p',body,'admin@example.test');
    });
    it('Неподтверждённый автор не изменяет лимит',async()=>{
        await expect(controller.updateQuota({projectKey:'p',limitBytes:100,expectedRevision:0},{headers:{}} as Request)).rejects.toMatchObject({status:403});expect(quota).not.toHaveBeenCalled();
    });
    it('Пустой проект отклоняется до проверки роли и обращения к БД',async()=>{
        await expect(controller.quota('',req)).rejects.toMatchObject({status:400});expect(assertMinLevel).not.toHaveBeenCalled();expect(quota).not.toHaveBeenCalled();
    });
});
