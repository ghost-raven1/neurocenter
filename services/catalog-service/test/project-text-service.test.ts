import {ForbiddenException} from '@nestjs/common';
import type {Request} from 'express';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {ProjectTextKnowledge,textRequestHash,requireTextResult} from '../src/project-text/project-text.service';
import {ModelChatProjectContext} from '../src/model-chat/chat-project-context';
import {requireFeatureEnabled} from '../src/features/require-feature-enabled';

vi.mock('../src/features/require-feature-enabled',()=>({requireFeatureEnabled:vi.fn()}));
const projectId='prj-text-fixture',req={}as Request;
const input={requestKey:'11111111-1111-4111-8111-111111111111',expectedRevision:0,documents:[{path:'README.md',content:'Проект использует надёжную очередь.\n'}]};
const state={mode:'text' as const,projectId,revision:1,corpusHash:'b'.repeat(64),documentCount:1,bytes:64,updatedAt:'2026-10-29T00:00:00.000Z'};
const selection={mode:'text' as const,revision:1,corpusHash:state.corpusHash,query:'надёжную очередь'};
const source={id:'c'.repeat(64),path:'README.md',startLine:1,endLine:1,excerpt:input.documents[0].content.trim(),score:1};
const receipt={...state,requestKey:input.requestKey,requestHash:textRequestHash(input),acceptedAt:state.updatedAt};

function fixture(){
    let readable=true,writable=true,enabled=true;let retained:typeof receipt|null=null;
    const actor={email:'developer@example.test',activeRole:'Разработчик'},release=vi.fn();
    const query=vi.fn(async(sql:string)=>({rows:sql.startsWith('SELECT id FROM projects')?[{id:projectId}]:sql.startsWith('SELECT enabled')?[{enabled,is_main_admin:false}]:sql.startsWith('SELECT project_id,role')?(writable?[{project_id:projectId,role:actor.activeRole}]:[]):[],rowCount:1}));
    const models={pool:{query,connect:async()=>({query,release})},actor:vi.fn(async()=>actor),resolveProject:vi.fn(async(_req,id,level=1)=>{
        if(id!==projectId||!readable||level>=2&&!writable)throw new ForbiddenException('Project authority revoked');
        return {id:projectId,name:'Text fixture',state:'active',headRevision:1};
    })};
    const service=new ProjectTextKnowledge(models as never);
    const transport=vi.spyOn(service.client,'call').mockImplementation(async(path,body)=>{
        if(path==='text/state')return state as never;
        if(path==='text/receipt')return retained as never;
        if(path==='text/upload')return receipt as never;
        if(path==='text/search')return {mode:'text',projectId,revision:state.revision,corpusHash:state.corpusHash,sources:[source]}as never;
        throw Error('Unexpected external operation '+path);
    });
    return {service,models,transport,query,release,actor,setRead:(value:boolean)=>{readable=value;},setWrite:(value:boolean)=>{writable=value;},setEnabled:(value:boolean)=>{enabled=value;},save:()=>{retained=receipt;}};
}
beforeEach(()=>{vi.mocked(requireFeatureEnabled).mockReset().mockResolvedValue();});
afterEach(()=>{vi.restoreAllMocks();});

describe('Text knowledge admission, exact receipt recovery and scoped reads',()=>{
    it('never accesses another project and rechecks read authority after the RAG response',async()=>{
        const f=fixture();await expect(f.service.state(req,'prj-foreign')).rejects.toHaveProperty('status',403);expect(f.transport).not.toHaveBeenCalled();
        f.transport.mockImplementationOnce(async()=>{f.setRead(false);return state as never;});
        await expect(f.service.state(req,projectId)).rejects.toHaveProperty('status',403);
    });
    it('recovers the same committed receipt after lost ACK with the feature OFF and no new upload',async()=>{
        const f=fixture();f.transport.mockImplementation(async path=>{
            if(path==='text/receipt')return null as never;
            if(path==='text/upload'){f.save();throw Error('ACK lost after commit');}
            throw Error('Unexpected route');
        });
        await expect(f.service.upload(req,projectId,input)).rejects.toThrow('ACK lost');
        f.transport.mockImplementation(async path=>{if(path==='text/receipt')return receipt as never;throw Error('Replay must not write');});
        vi.mocked(requireFeatureEnabled).mockRejectedValue(new ForbiddenException('OFF'));
        expect(await f.service.upload(req,projectId,input)).toEqual(receipt);
        expect(f.transport.mock.calls.filter(([path])=>path==='text/upload')).toHaveLength(1);
    });
    it('rejects changed bytes under the same key before checking a new admission flag',async()=>{
        const f=fixture();f.save();
        await expect(f.service.upload(req,projectId,{...input,documents:[{...input.documents[0],content:'other bytes'}]})).rejects.toHaveProperty('status',409);
        expect(requireFeatureEnabled).not.toHaveBeenCalled();
    });
    it('keeps a committed receipt but refuses delivery after read access is revoked during upload',async()=>{
        const f=fixture();f.transport.mockImplementation(async path=>{
            if(path==='text/receipt')return null as never;
            if(path==='text/upload'){f.save();f.setRead(false);return receipt as never;}
            throw Error('Unexpected route');
        });
        await expect(f.service.upload(req,projectId,input)).rejects.toHaveProperty('status',403);
        f.setRead(true);f.transport.mockImplementation(async path=>{if(path==='text/receipt')return receipt as never;throw Error('Replay must not write');});
        expect(await f.service.upload(req,projectId,input)).toEqual(receipt);
        expect(f.transport.mock.calls.filter(([path])=>path==='text/upload')).toHaveLength(1);
    });
    it('OFF and revoked write role prohibit a new upload while receipt/state reads remain available',async()=>{
        const f=fixture();vi.mocked(requireFeatureEnabled).mockRejectedValueOnce(new ForbiddenException('OFF'));
        await expect(f.service.upload(req,projectId,input)).rejects.toHaveProperty('status',403);
        expect(f.transport.mock.calls.some(([path])=>path==='text/upload')).toBe(false);
        f.setWrite(false);await expect(f.service.upload(req,projectId,input)).rejects.toHaveProperty('status',403);
        expect(await f.service.state(req,projectId)).toEqual(state);
    });
    it.each(['account','membership'])('fresh pre-mutation callback denies a revoked %s and rolls back',async reason=>{
        const f=fixture();if(reason==='account')f.setEnabled(false);else f.setWrite(false);
        await expect(f.service.authorize({projectId,actor:f.actor,requestKey:input.requestKey,requestHash:textRequestHash(input)})).rejects.toHaveProperty('status',403);
        expect(f.query.mock.calls.some(([sql])=>sql==='COMMIT')).toBe(false);expect(f.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');expect(f.release).toHaveBeenCalledOnce();
    });
    it('new write authority uses the existing fresh author fence and only the independent text feature',async()=>{
        const f=fixture();expect(await f.service.authorize({projectId,actor:f.actor,requestKey:input.requestKey,requestHash:textRequestHash(input)})).toEqual({ok:true});
        expect(requireFeatureEnabled).toHaveBeenCalledExactlyOnceWith('project_text_knowledge');
        expect(f.query.mock.calls.map(([sql])=>sql)).toContain('COMMIT');
    });
    it('rejects stale search revision and malformed citations instead of fabricating an empty result',async()=>{
        const f=fixture();await expect(f.service.search(req,projectId,{query:'очередь',revision:0})).rejects.toHaveProperty('status',409);
        expect(()=>requireTextResult({mode:'text',projectId,revision:1,corpusHash:state.corpusHash,sources:[{...source,startLine:0}]},projectId)).toThrow('цитату');
    });
});

describe('Explicit text context has no embedding or semantic fallback',()=>{
    it('returns cited text with the accepted revision without calling the model runtime',async()=>{
        const f=fixture(),runtime={infer:vi.fn()},context=new ModelChatProjectContext(f.models as never,runtime as never);
        vi.spyOn(context.text.client,'call').mockImplementation(f.transport.getMockImplementation()!);
        const prepared=await context.prepareText(req,projectId,selection,new AbortController().signal);
        expect(prepared.evidence).toMatchObject({mode:'text',textRevision:1,corpusHash:state.corpusHash,sources:[source]});
        expect(runtime.infer).not.toHaveBeenCalled();expect(prepared.requiredFeatures).toEqual(['project_text_knowledge']);
        await prepared.beforeInference();expect(runtime.infer).not.toHaveBeenCalled();
    });
    it('refuses a changed corpus and cancellation before any paid operation',async()=>{
        const f=fixture(),runtime={infer:vi.fn()},context=new ModelChatProjectContext(f.models as never,runtime as never);
        vi.spyOn(context.text.client,'call').mockImplementation(f.transport.getMockImplementation()!);
        await expect(context.prepareText(req,projectId,{...selection,revision:0},new AbortController().signal)).rejects.toHaveProperty('status',409);
        const cancelled=new AbortController();cancelled.abort(new Error('Explicit stop'));
        await expect(context.prepareText(req,projectId,selection,cancelled.signal)).rejects.toThrow('Explicit stop');expect(runtime.infer).not.toHaveBeenCalled();
    });
});
