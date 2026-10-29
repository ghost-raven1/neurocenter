import {beforeEach,describe,expect,it,vi} from 'vitest';
import {ForbiddenException} from '@nestjs/common';
import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {GgufImports} from '../src/models/gguf-import/gguf-import.service';
import {ggufIntent,ggufAcceptance,type GgufUploadRow} from '../src/models/gguf-import/gguf-import.model';
import {ggufImportPolicy} from '../../shared/gguf-import-policy.cjs';
import {requiredRouteFeatures} from '../../shared/feature-policy.cjs';

vi.mock('../../shared/capacity.cjs',()=>({reserveCapacity:vi.fn(async()=>()=>{}),CapacityError:class extends Error{statusCode=507;}}));
vi.mock('../src/models/gguf-import/gguf-import.capacity',()=>({assertGgufCapacity:vi.fn(async()=>{})}));
const actor={email:'admin@example.invalid',activeRole:'Главный админ' as const},epoch=randomUUID(),initialPolicy=ggufImportPolicy();
describe('GGUF durable control-plane contracts with controlled DB boundary',()=>{
 let service:GgufImports,row:GgufUploadRow|undefined,model:any,policy=initialPolicy,enabled:boolean,flags:ReturnType<typeof vi.fn>,query:ReturnType<typeof vi.fn>,release:ReturnType<typeof vi.fn>,commitLost:boolean,policyUnavailable:boolean;
 beforeEach(()=>{
  row=undefined;model=undefined;policy=initialPolicy;enabled=true;commitLost=false;policyUnavailable=false;flags=vi.fn(async()=>{});release=vi.fn();
  query=vi.fn(async(sql:string,values:unknown[]=[])=>{
   if(sql.startsWith('SELECT source_upload_auth_epoch'))return {rows:enabled?[{epoch,enabled:true,is_main_admin:true}]:[]};
   if(sql.includes('SUM(bytes)'))return {rows:[{bytes:row&&row.state!=='CANCELLED'?String(row.bytes):'0',pending:row&&row.state!=='ACCEPTED'?'1':'0'}]};
   if(sql.startsWith('SELECT * FROM model_gguf_uploads WHERE actor='))return {rows:row&&values[0]===row.actor&&(sql.includes('request_key')?values[1]===row.request_key:values[1]===row.id)?[structuredClone(row)]:[]};
   if(sql.startsWith('SELECT * FROM model_gguf_uploads WHERE id='))return {rows:row?[structuredClone(row)]:[]};
   if(sql.startsWith('INSERT INTO model_gguf_uploads')){row={id:String(values[0]),actor:String(values[1]),request_key:String(values[2]),request_hash:String(values[3]),file_name:String(values[4]),bytes:String(values[5]),expected_sha256:values[6] as string|null,state:'WAITING',auth_epoch:String(values[7]),limits:JSON.parse(String(values[8])),expires_at:values[9] as Date,sha256:null,metadata:null,lease_token:null,model_id:null,accept_hash:null,created_at:new Date(),updated_at:new Date(),cleaned_at:null};return {rows:[structuredClone(row)],rowCount:1};}
   if(sql.startsWith('SELECT * FROM model_catalog'))return {rows:model?[model]:[]};
   if(sql.startsWith('SELECT id FROM model_catalog WHERE lower(name)'))return {rows:[],rowCount:0};
   if(sql.startsWith('INSERT INTO model_catalog(')){model={id:values[0],name:values[1],descriptor:JSON.parse(String(values[2])),revision:1,created_at:new Date(),updated_at:new Date()};return {rows:[model],rowCount:1};}
   if(sql.startsWith('UPDATE model_gguf_uploads')){
    if(sql.includes("state='ACCEPTED'")){row!.state='ACCEPTED';row!.model_id=String(values[1]);row!.accept_hash=String(values[2]);}
    if(sql.includes("state='CANCELLED'")){row!.state='CANCELLED';row!.lease_token=null;}
    return {rows:[structuredClone(row)],rowCount:1};
   }
   if(sql==='COMMIT'&&commitLost){commitLost=false;throw Error('lost commit acknowledgement');}
   if(sql.includes('pg_try_advisory'))return {rows:[{locked:true}]};
   return {rows:[],rowCount:1};
  });
  const pool={query,connect:async()=>({query,release})} as unknown as Pool;
  service=new GgufImports(pool,'/owned-test-gguf-not-created',async()=>{if(policyUnavailable)throw Error('policy unavailable');return policy;},flags);
  vi.spyOn(service.files,'digest').mockResolvedValue('a'.repeat(64));vi.spyOn(service.files,'remove').mockResolvedValue();
 });
 const create=()=>service.create(actor,{requestKey:randomUUID(),fileName:'model.gguf',bytes:128});
 const ready=()=>{row!.state='READY';row!.sha256='a'.repeat(64);row!.metadata={format:'gguf',version:3,architecture:'llama',tensorCount:1,metadataCount:1};};
 it('creates one request, freezes policy, and returns that receipt even with OFF and a lower current limit',async()=>{const first=await create();policy={...initialPolicy,maximumBytes:8};flags.mockRejectedValue(new ForbiddenException('OFF'));const replay=await service.create(actor,{requestKey:first.requestKey,fileName:first.fileName,bytes:first.bytes});expect(replay).toEqual(first);expect(replay.limits.maximumBytes).toBe(initialPolicy.maximumBytes);expect(query.mock.calls.filter(([sql])=>sql.startsWith('INSERT INTO model_gguf_uploads'))).toHaveLength(1);});
 it('rejects a changed file under the same UUID',async()=>{const first=await create();await expect(service.create(actor,{requestKey:first.requestKey,fileName:first.fileName,bytes:127})).rejects.toMatchObject({status:409});});
 it('returns an accepted request receipt while the current policy provider is unavailable',async()=>{const first=await create();policyUnavailable=true;await expect(service.create(actor,{requestKey:first.requestKey,fileName:first.fileName,bytes:first.bytes})).resolves.toEqual(first);await expect(create()).rejects.toThrow('policy unavailable');});
 it('blocks new admission when OFF before reserving a durable request',async()=>{flags.mockRejectedValue(new ForbiddenException('OFF'));await expect(create()).rejects.toMatchObject({status:403});expect(row).toBeUndefined();});
 it('checks fresh Main-admin rights independently from flags and owner identifiers',async()=>{await create();enabled=false;await expect(service.get(actor,row!.id)).rejects.toMatchObject({status:403});enabled=true;await expect(service.get({...actor,email:'other@example.invalid'},row!.id)).rejects.toMatchObject({status:404});await expect(service.get({...actor,activeRole:'Разработчик'},row!.id)).rejects.toMatchObject({status:403});});
 it('accounts for reserved bytes and pending imports before another request is inserted',async()=>{policy={...initialPolicy,storageQuotaBytes:128};await create();await expect(create()).rejects.toMatchObject({status:409});expect(query.mock.calls.filter(([sql])=>sql.startsWith('INSERT INTO model_gguf_uploads'))).toHaveLength(1);});
 it('accepts a checked source into a stable existing-model record, preserving file vs manifest identity',async()=>{await create();ready();const saved=await service.accept(actor,row!.id,{name:'Imported',capability:'chat'});expect(saved).toMatchObject({id:'model-gguf-'+row!.id,runtime:'ollama',source:'custom',manifestSha256:null,dimension:null,fileImport:{sha256:'a'.repeat(64),bytes:128,fileName:'model.gguf',format:'gguf'}});expect(row!.state).toBe('ACCEPTED');expect(query.mock.calls.some(([sql])=>sql.startsWith('INSERT INTO model_catalog_versions'))).toBe(true);expect(query.mock.calls.some(([sql])=>sql.startsWith('INSERT INTO security_events'))).toBe(true);expect(query.mock.calls.at(-1)).toEqual(['COMMIT']);});
 it('reconciles a lost accept acknowledgement through the same model receipt without re-creating after OFF',async()=>{await create();ready();commitLost=true;await expect(service.accept(actor,row!.id,{name:'Imported',capability:'embedding'})).rejects.toThrow('lost commit');flags.mockRejectedValue(new ForbiddenException('OFF'));const replay=await service.accept(actor,row!.id,{name:'Imported',capability:'embedding'});expect(replay.id).toBe(model.id);expect(query.mock.calls.filter(([sql])=>sql.startsWith('INSERT INTO model_catalog('))).toHaveLength(1);});
 it('rejects changed acceptance and cancellation after a durable model was created',async()=>{await create();ready();await service.accept(actor,row!.id,{name:'Imported',capability:'chat'});await expect(service.accept(actor,row!.id,{name:'Changed',capability:'chat'})).rejects.toMatchObject({status:409});await expect(service.cancel(actor,row!.id)).rejects.toMatchObject({status:409});expect(service.files.remove).not.toHaveBeenCalled();});
 it('rechecks cancellation after the expensive file hash, before any model insert',async()=>{await create();ready();vi.mocked(service.files.digest).mockImplementation(async()=>{row!.state='CANCELLED';return 'a'.repeat(64);});await expect(service.accept(actor,row!.id,{name:'Imported',capability:'chat'})).rejects.toMatchObject({status:409});expect(model).toBeUndefined();});
 it('rechecks revoked rights after the file hash, before any model insert',async()=>{await create();ready();vi.mocked(service.files.digest).mockImplementation(async()=>{enabled=false;return 'a'.repeat(64);});await expect(service.accept(actor,row!.id,{name:'Imported',capability:'chat'})).rejects.toMatchObject({status:403});expect(model).toBeUndefined();});
 it('allows read/cancel after OFF and makes cleanup wait for the active stream lease',async()=>{await create();flags.mockRejectedValue(new ForbiddenException('OFF'));await expect(service.get(actor,row!.id)).resolves.toMatchObject({state:'WAITING'});const previous=query.getMockImplementation()!;query.mockImplementation(async(sql:string,values?:unknown[])=>sql.includes('pg_try_advisory_xact_lock')?{rows:[{locked:false}]}:previous(sql,values));await expect(service.cancel(actor,row!.id)).resolves.toMatchObject({state:'CANCELLED'});expect(service.files.remove).not.toHaveBeenCalled();expect(query.mock.calls.some(([sql])=>sql.includes('SET cleaned_at'))).toBe(false);});
 it('rejects expired or stale-epoch READY imports before acceptance',async()=>{await create();ready();row!.expires_at=new Date(0);await expect(service.accept(actor,row!.id,{name:'Imported',capability:'chat'})).rejects.toMatchObject({status:409});row!.expires_at=new Date(Date.now()+10000);row!.auth_epoch=randomUUID();await expect(service.accept(actor,row!.id,{name:'Imported',capability:'chat'})).rejects.toMatchObject({status:403});expect(model).toBeUndefined();});
 it('routes all GGUF operations through owner admission so flags do not hide receipts',()=>{for(const [method,path]of[['POST','/api/models/gguf-imports'],['PUT','/api/models/gguf-imports/'+randomUUID()+'/content'],['POST','/api/models/gguf-imports/'+randomUUID()+'/accept'],['DELETE','/api/models/gguf-imports/'+randomUUID()]])expect(requiredRouteFeatures(method,path,{})).toEqual([]);});
 it('validates intent and disallows URL, archive, vision and execute options',()=>{const requestKey=randomUUID();for(const input of [{requestKey,fileName:'../a.gguf',bytes:10},{requestKey,fileName:'я'.repeat(120)+'.gguf',bytes:10},{requestKey,fileName:'a.zip',bytes:10},{requestKey,fileName:'a.gguf',bytes:0},{requestKey,fileName:'a.gguf',bytes:10,url:'https://example.invalid'}])expect(()=>ggufIntent(input,initialPolicy)).toThrow();for(const input of [{name:'M',capability:'vision'},{name:'M',capability:'chat',template:'x'}])expect(()=>ggufAcceptance(input,requestKey)).toThrow();});
});
