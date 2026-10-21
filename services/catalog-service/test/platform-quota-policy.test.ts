import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {Request} from 'express';
import type {AccessDb} from '../src/access/access-db';
import {RagQuotaPolicyController} from '../src/maintenance/rag-quota-policy.controller';
import {allowRequest} from '../src/access/access-policy';
const req=(role='Главный админ',email='admin@example.test')=>({headers:{'x-neurocenter-internal':'internal-test-only','x-bridge-actor':encodeURIComponent(JSON.stringify({activeRole:role,email}))}} as unknown as Request);
const claims=vi.fn(),fetchMock=vi.fn();
const policy={defaultBytes:1024,maximumBytes:64*1024**3,revision:1,updatedAt:'2026-10-22T00:00:00Z',updatedBy:'admin@example.test'};
const controller=new RagQuotaPolicyController({claims} as unknown as AccessDb);
beforeEach(()=>{vi.clearAllMocks();vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN','internal-test-only');vi.stubEnv('RAG_SERVICE_URL','http://rag-only.test');vi.stubGlobal('fetch',fetchMock);
    claims.mockResolvedValue({email:'admin@example.test',userRoles:['Главный админ']});fetchMock.mockResolvedValue(new Response(JSON.stringify(policy)));});
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();});

describe('Main-admin platform quota coordinator',()=>{
    it('GET checks fresh claims and sends only the internal token to RAG',async()=>{
        expect(await controller.get(req())).toEqual(policy);expect(claims).toHaveBeenCalledWith('admin@example.test');
        const [url,options]=fetchMock.mock.calls[0];expect(url).toBe('http://rag-only.test/internal/platform-rag-quota');
        expect(options).toMatchObject({method:'GET',redirect:'error',headers:{'x-neurocenter-internal':'internal-test-only'}});expect(options.body).toBeUndefined();
    });
    it('PATCH takes its actor from checked claims and leaves field validation to the data owner',async()=>{
        const input={defaultBytes:1024,maximumBytes:64*1024**3,expectedRevision:0};expect(await controller.save(req(),input)).toEqual(policy);
        expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({policy:input,actor:'admin@example.test'});
    });
    it.each(['Админ проекта','Разработчик','Наблюдатель'])('active role %s cannot bypass the coordinator or public policy',async role=>{
        await expect(controller.get(req(role))).rejects.toMatchObject({status:403});expect(fetchMock).not.toHaveBeenCalled();
        expect(allowRequest({userRoles:[role]} as never,role,{method:'PATCH',path:'/api/maintenance/rag-quota-policy'})).toBe(false);
    });
    it('revocation and missing internal authentication fail closed',async()=>{
        claims.mockResolvedValue({email:'admin@example.test',userRoles:[]});await expect(controller.save(req(),{})).rejects.toMatchObject({status:403});
        await expect(controller.get({headers:{}} as Request)).rejects.toMatchObject({status:403});expect(fetchMock).not.toHaveBeenCalled();
    });
    it.each([400,409])('preserves upstream validation/CAS status %s',async status=>{
        fetchMock.mockResolvedValue(new Response(JSON.stringify({message:'Настройки уже изменены'}),{status}));
        await expect(controller.save(req(),{})).rejects.toMatchObject({status,response:{message:'Настройки уже изменены'}});
    });
    it.each(['network','malformed','oversize','upstream'])('does not certify settings during %s failure',async failure=>{
        if(failure==='network')fetchMock.mockRejectedValue(new Error('private-host-and-key'));
        else fetchMock.mockResolvedValue(new Response(failure==='malformed'?'bad-json':failure==='oversize'?'x'.repeat(17000):'{}',{status:failure==='upstream'?500:200}));
        await expect(controller.get(req())).rejects.toMatchObject({status:503,response:{message:expect.stringContaining('Сохранённые лимиты')}});
    });
});
