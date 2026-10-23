import {describe,expect,it} from 'vitest';
import {createHash} from 'node:crypto';
import {QUIRKS_LIMITS,normalizeQuirksLimits,parseQuirksJsonl,preflightQuirkImport,quirkExperienceKey,quirkReportedExperience,normalizeQuirkSource,normalizeQuirksReceipt,supportsLearningQuirks,QUIRKS_SOURCE_SHA256} from '../../shared/project-learning-quirks.cjs';
import {normalizeLearningObservedExperienceInput} from '../../shared/project-learning.cjs';
import {importQuirkSnapshot} from '../src/learning-quirks/learning-quirks-import';

const target={projectId:'prj-quirks',instanceId:'11111111-1111-4111-8111-111111111111'};
const quirk={id:'quirk:22222222-2222-4222-8222-222222222222',content:'Use a fixture database for tests.',quirkType:'gotcha',tags:['postgres'],confidence:0.95,lastObserved:'2026-10-24T01:00:00.000Z',sourceRef:'notes/test.md:12'};
const raw=JSON.stringify(quirk),jsonl=raw+'\n',sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const source={fileSha256:sha(jsonl),assetId:'rag',assetKind:'mcp' as const,version:12,manifest:'b'.repeat(64),configurationRevision:null};
describe('RAG quirks reported source contract',()=>{
    it('retains raw identity and every upstream field, with hashes of exact source bytes',()=>{
        const snapshot=parseQuirksJsonl(jsonl),input=quirkReportedExperience(target,snapshot.records[0],source);
        expect(snapshot.fileSha256).toBe(sha(jsonl));expect(snapshot.records[0].recordSha256).toBe(sha(raw));
        expect(input.source?.quirk).toEqual(quirk);expect(input.source?.quirk.id).toBe(quirk.id);expect(input.summary).toBe(quirk.content);
        expect(input.outcome).toBe('unknown');expect(input.evidence.every(item=>item.status==='unknown')).toBe(true);
        expect(input.source?.trust).toBe('reported');expect(normalizeLearningObservedExperienceInput(input)).toEqual(input);
    });
    it.each(['','\n',' \n'])('accepts a valid empty source without treating it as a deletion snapshot',value=>{
        expect(parseQuirksJsonl(value)).toEqual({fileSha256:sha(value),records:[]});
    });
    it.each([raw,jsonl+'{bad}\n',jsonl+jsonl,jsonl+'\n',JSON.stringify({...quirk,confidence:'0.95'})+'\n',JSON.stringify({...quirk,confidence:null})+'\n',
        JSON.stringify({...quirk,id:quirk.id.slice(6)})+'\n',JSON.stringify({...quirk,lastObserved:'not-date'})+'\n',JSON.stringify({...quirk,content:'\ud800'})+'\n',
        JSON.stringify({...quirk,relationship:{from:'admin',to:'policy'}})+'\n',' '.repeat(QUIRKS_LIMITS.bytes+1)+'\n'])('rejects torn, corrupt, duplicate and unsupported source before import',value=>{
        expect(()=>parseQuirksJsonl(value)).toThrow();
    });
    it('keeps unchanged records stable across source reordering/import attempts, changed bytes immutable',()=>{
        const original=parseQuirksJsonl(jsonl).records[0],other={...quirk,id:'quirk:33333333-3333-4333-8333-333333333333'};
        const reordered=parseQuirksJsonl(JSON.stringify(other)+'\n'+jsonl).records[1],modified=parseQuirksJsonl(JSON.stringify({...quirk,content:'New report'})+'\n').records[0];
        const key=(entry:typeof original)=>quirkExperienceKey(target.projectId,target.instanceId,entry.quirk.id,entry.recordSha256);
        expect(key(original)).toBe(key(reordered));expect(key(original)).not.toBe(key(modified));
        expect(quirkExperienceKey('other-project',target.instanceId,quirk.id,original.recordSha256)).not.toBe(key(original));
        expect(quirkExperienceKey(target.projectId,'44444444-4444-4444-8444-444444444444',quirk.id,original.recordSha256)).not.toBe(key(original));
    });
    it('preserves finite reported confidence and optional empty upstream metadata without interpreting authority',()=>{
        const value={...quirk,confidence:2,quirkType:'',tags:[''],sourceRef:''};
        expect(parseQuirksJsonl(JSON.stringify(value)+'\n').records[0].quirk).toEqual(value);
    });
    it('refuses source authority escalation and hidden public result text',()=>{
        const input=quirkReportedExperience(target,parseQuirksJsonl(jsonl).records[0],source);
        expect(()=>normalizeQuirkSource({...input.source,trust:'approved'})).toThrow();
        expect(()=>normalizeQuirkSource({...input.source,relations:[]})).toThrow();
        expect(()=>normalizeQuirksReceipt({schemaVersion:1,status:'complete',sourceCount:1,imported:1,skipped:0,remaining:0,fileSha256:sha(jsonl),safeRetry:true,content:quirk.content})).toThrow();
    });
    it('requires the exact declared prepared upstream format',()=>{
        const pkg={schemaVersion:5,plugin:{kind:'mcp'},config:{transport:'stdio',extra:{learningQuirks:{schemaVersion:1,format:'opencode-rag-quirks-jsonl',sourceSha256:QUIRKS_SOURCE_SHA256}}}};
        expect(supportsLearningQuirks(pkg)).toBe(true);
        expect(supportsLearningQuirks({...pkg,config:{...pkg.config,transport:'remote'}})).toBe(false);
        expect(supportsLearningQuirks({...pkg,config:{...pkg.config,extra:{learningQuirks:{...pkg.config.extra.learningQuirks,sourceSha256:'a'.repeat(64)}}}})).toBe(false);
    });
    it('preflights new experience quota without charging unchanged record retries',()=>{
        const snapshot=parseQuirksJsonl(jsonl),id=quirkExperienceKey(target.projectId,target.instanceId,quirk.id,snapshot.records[0].recordSha256);
        expect(()=>preflightQuirkImport(snapshot,target,[],0)).toThrow('квот');
        expect(preflightQuirkImport(snapshot,target,[id],0)).toEqual({newCount:0,existingCount:1});
        expect(()=>parseQuirksJsonl(' '.repeat(QUIRKS_LIMITS.bytes+1))).toThrow('квот');
    });
    it('normalizes server-owned physical limits and rejects expanding or hidden settings',()=>{
        expect(normalizeQuirksLimits({records:2,importedExperiences:0})).toMatchObject({records:2,importedExperiences:0});
        for(const value of [{bytes:QUIRKS_LIMITS.bytes+1},{records:1.5},{records:NaN},{path:'../other'},{records:0}])expect(()=>normalizeQuirksLimits(value)).toThrow();
        expect(()=>parseQuirksJsonl(jsonl,{contentBytes:2})).toThrow('квот');
    });
    it('reports partial commit after a late authorization failure and safe repeat completes without duplicates',async()=>{
        const second={...quirk,id:'quirk:33333333-3333-4333-8333-333333333333'},snapshot=parseQuirksJsonl(jsonl+JSON.stringify(second)+'\n'),saved=new Set<string>();
        const append=async(entry:typeof snapshot.records[0])=>{const key=quirkExperienceKey(target.projectId,target.instanceId,entry.quirk.id,entry.recordSha256);if(saved.has(key))return false;saved.add(key);return true;};
        const partial=await importQuirkSnapshot(snapshot,append,async()=>{if(saved.size)throw new Error('ACL revoked');});
        expect(partial).toMatchObject({status:'partial',imported:1,remaining:1,safeRetry:true});expect(saved.size).toBe(1);
        const retry=await importQuirkSnapshot(snapshot,append,async()=>{});expect(retry).toMatchObject({status:'complete',imported:1,skipped:1,remaining:0});expect(saved.size).toBe(2);
        const lostAck=await importQuirkSnapshot(snapshot,append,async()=>{});expect(lostAck).toMatchObject({status:'complete',imported:0,skipped:2});
    });
});
