import {describe,expect,it} from 'vitest';
import {chatSearchChunk,chatSearchInput,cosine,embeddingVectors} from '../src/chat-search/chat-search.math';
import {allowRequest} from '../src/access/access-policy';
import type {IAccessClaims} from '../src/access/access.model';
const valid={requestKey:'11111111-1111-4111-8111-111111111111',modelId:'model-embed',expectedModelPin:'a'.repeat(64),consent:true};
describe('Semantic chat boundaries',()=>{
    it('requires explicit consent for both indexing and query inference',()=>{for(const kind of ['index','search'] as const)for(const consent of [false,undefined,'true'])expect(()=>chatSearchInput({...valid,consent,...kind==='search'?{query:'Транспортный ремонт'}:{}},kind)).toThrow();});
    it('bounds index chunks, query bytes and result count',()=>{
        expect(chatSearchInput(valid,'index').limit).toBe(32);expect(chatSearchInput({...valid,query:'  Смысл  '},'search').query).toBe('Смысл');
        for(const raw of [{...valid,limit:33},{...valid,limit:0},{...valid,modelId:'external-url'},{...valid,expectedModelPin:'bad'},{...valid,extra:true}])expect(()=>chatSearchInput(raw,'index')).toThrow();
        expect(()=>chatSearchInput({...valid,query:'a'.repeat(8193)},'search')).toThrow();expect(()=>chatSearchInput({...valid,query:'  '},'search')).toThrow();
    });
    it('uses complete Unicode chunks consistent with PostgreSQL character positions',()=>{
        const text='😀'.repeat(2048)+'日本語';expect(Array.from(chatSearchChunk(text,0))).toHaveLength(2048);expect(chatSearchChunk(text,1)).toBe('日本語');
    });
    it('ranks numeric semantic similarity without requiring shared query words',()=>{
        const query=[1,0],repair=[0.99,0.1],budget=[0,1];expect(cosine(query,repair)).toBeGreaterThan(cosine(query,budget));
        expect(cosine(query,repair)).toBeCloseTo(0.9949,3);
    });
    it.each([[],[[1]],[[NaN,1]],[[Infinity,1]],[[0,0]],[[1,0],[0,1]]])('rejects invalid/incomplete vector output %j',value=>expect(()=>embeddingVectors(value,1,2)).toThrow());
    it('accepts real vectors with their exact dimension',()=>expect(embeddingVectors([[0.25,-0.5]],1,2)).toEqual([[0.25,-0.5]]));
    it('allows current project workers to create paid requests and readers to recover/cancel their own jobs',()=>{
        const claims:IAccessClaims={email:'fixture@test.invalid',userRoles:['Разработчик','Наблюдатель'],projects:[{projectId:'prj-work',projectName:'Work',role:'Разработчик'},{projectId:'prj-read',projectName:'Read',role:'Наблюдатель'}],pluginIds:[],skillPaths:[]};
        const id=valid.requestKey;
        expect(allowRequest(claims,'Разработчик',{method:'POST',path:'/api/projects/prj-work/chat-search/search'})).toBe(true);
        expect(allowRequest(claims,'Наблюдатель',{method:'POST',path:'/api/projects/prj-read/chat-search/index'})).toBe(false);
        expect(allowRequest(claims,'Наблюдатель',{method:'GET',path:'/api/projects/prj-read/chat-search'})).toBe(true);
        expect(allowRequest(claims,'Наблюдатель',{method:'DELETE',path:'/api/projects/prj-read/chat-search/jobs/'+id})).toBe(true);
        expect(allowRequest(claims,'Разработчик',{method:'POST',path:'/api/projects/prj-work/chat-search/unknown'})).toBe(false);
        expect(allowRequest(claims,'Разработчик',{method:'GET',path:'/api/projects/prj-stranger/chat-search'})).toBe(false);
    });
});
