import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {deliverSkillAudit} from '../src/storage/skill-audit';
import type {ISkillAuditEvent} from '../../shared/skill-audit.cjs';

const event=():ISkillAuditEvent=>({id:randomUUID(),at:new Date().toISOString(),actor:'operator@example.test',source:'editor',action:'skill.create',resourceId:'common/helper',before:null,
    after:{generation:'test-generation',version:1,sha256:'a'.repeat(64)}});
const response=(accepted:unknown,status=200)=>new Response(JSON.stringify({accepted}),{status});

describe('Внутреннее подтверждение аудита скиллов',()=>{
    beforeEach(()=>{vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN','test-internal-token');vi.stubEnv('CATALOG_SERVICE_URL','http://127.0.0.1:4100');});
    afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();});
    it('Передаёт сводку с тем же UUID по внутреннему маршруту и проверяет ACK',async()=>{
        const item=event();const request=vi.fn(async()=>response(1));vi.stubGlobal('fetch',request);await deliverSkillAudit([item]);
        const [url,options]=request.mock.calls[0] as unknown as [URL,RequestInit];
        expect(String(url)).toBe('http://127.0.0.1:4100/internal/skill-audit/events');expect(options.headers).toMatchObject({'x-neurocenter-internal':'test-internal-token'});
        expect(JSON.parse(options.body as string)).toEqual({events:[item]});expect(options.redirect).toBe('error');expect(options.signal).toBeInstanceOf(AbortSignal);
    });
    it('Разбивает большой пакет на 200/200/1 без новых UUID',async()=>{
        const items=Array.from({length:401},event);const chunks:ISkillAuditEvent[][]=[];
        vi.stubGlobal('fetch',vi.fn(async(_url:URL,options:RequestInit)=>{const chunk=JSON.parse(options.body as string).events;chunks.push(chunk);return response(chunk.length);}));
        await deliverSkillAudit(items);expect(chunks.map(chunk=>chunk.length)).toEqual([200,200,1]);expect(chunks.flat()).toEqual(items);
    });
    it.each([undefined,0,-1,2,'1',null])('Неполный ACK %j сохраняет необходимость повтора',async accepted=>{
        vi.stubGlobal('fetch',vi.fn(async()=>response(accepted)));await expect(deliverSkillAudit([event()])).rejects.toMatchObject({status:503});
    });
    it.each([403,409,500,503])('HTTP %s не считается доставленным аудитом',async status=>{
        vi.stubGlobal('fetch',vi.fn(async()=>response(1,status)));await expect(deliverSkillAudit([event()])).rejects.toMatchObject({status:503});
    });
    it('Повреждённый JSON и потеря сети не подтверждают событие',async()=>{
        vi.stubGlobal('fetch',vi.fn(async()=>new Response('{')));await expect(deliverSkillAudit([event()])).rejects.toMatchObject({status:503});
        vi.stubGlobal('fetch',vi.fn(async()=>{throw new Error('ACK потерян');}));await expect(deliverSkillAudit([event()])).rejects.toMatchObject({status:503});
    });
    it.each(['','file:///tmp/audit','http://user:password@localhost/'])('Некорректная конфигурация %s останавливает запрос',async base=>{
        const request=vi.fn();vi.stubGlobal('fetch',request);vi.stubEnv('CATALOG_SERVICE_URL',base);if(base===''){vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN','');}
        await expect(deliverSkillAudit([event()])).rejects.toMatchObject({status:503});expect(request).not.toHaveBeenCalled();
    });
});
