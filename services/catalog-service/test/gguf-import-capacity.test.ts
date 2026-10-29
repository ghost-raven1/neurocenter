import {afterEach,describe,expect,it,vi} from 'vitest';
import {Readable} from 'node:stream';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {Pool} from 'pg';
import {GgufImports} from '../src/models/gguf-import/gguf-import.service';
import type {GgufUploadRow} from '../src/models/gguf-import/gguf-import.model';
import {ggufImportPolicy} from '../../shared/gguf-import-policy.cjs';
import {reserveCapacity,CapacityError} from '../../shared/capacity.cjs';
import {gguf} from './gguf-import.fixture';

vi.mock('../../shared/capacity.cjs',async original=>{const actual=await original<typeof import('../../shared/capacity.cjs')>();return {...actual,reserveCapacity:vi.fn()};});
describe('GGUF disk budget includes the written file exactly once',()=>{
 let root:string;afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllEnvs();if(root)await fs.rm(root,{recursive:true,force:true});});
 it('accepts the checked file when the configured free-space floor remains, without reserving its bytes twice',async()=>{
  vi.stubEnv('CAPACITY_REQUIRED','false');root=await fs.mkdtemp(path.join(os.tmpdir(),'gguf-budget-'));const bytes=gguf(),limits=ggufImportPolicy(),budget=bytes.length+limits.diskReserveBytes;let active=0;
  vi.mocked(reserveCapacity).mockImplementation(async request=>{if(active+request.bytes>budget)throw new (CapacityError as unknown as new(code:string,resource:string)=>Error)('CAPACITY_LOW','runtime-artifacts');active+=request.bytes;return()=>{active-=request.bytes;};});
  const disk=await fs.statfs(root,{bigint:true});vi.spyOn(fs,'statfs').mockResolvedValue({...disk,bavail:BigInt(1024**3+limits.diskReserveBytes+1024),bsize:1n} as never);
  const row={id:randomUUID(),actor:'admin@example.invalid',request_key:randomUUID(),request_hash:'a'.repeat(64),file_name:'fixture.gguf',bytes:String(bytes.length),expected_sha256:null,sha256:null,state:'WAITING',auth_epoch:randomUUID(),lease_token:null,metadata:null,limits,model_id:null,accept_hash:null,expires_at:new Date(Date.now()+10000),created_at:new Date(),updated_at:new Date(),cleaned_at:null} as GgufUploadRow;
  const query=vi.fn(async(sql:string,values:any[]=[])=>{if(sql.includes('pg_try_advisory_lock'))return {rows:[{locked:true}]};if(sql.startsWith('UPDATE model_gguf_uploads')){if(sql.includes("state='UPLOADING'")){row.state='UPLOADING';row.lease_token=values[1];}if(sql.includes("state='READY'")){row.state='READY';row.sha256=values[1];row.metadata=JSON.parse(values[2]);row.lease_token=null;}return {rows:[structuredClone(row)],rowCount:1};}return {rows:[],rowCount:1};}),pool={query,connect:async()=>({query,on:vi.fn(),off:vi.fn(),release:vi.fn()})} as unknown as Pool;
  const imports=new GgufImports(pool,root,async()=>limits,async()=>{});await imports.files.setup();vi.spyOn(imports,'authorize').mockResolvedValue(row.auth_epoch);vi.spyOn(imports.repository,'get').mockImplementation(async()=>structuredClone(row));vi.spyOn(imports.repository,'quota').mockResolvedValue();
  await expect(imports.content({email:row.actor,activeRole:'Главный админ'},row.id,Readable.from([bytes]),bytes.length)).resolves.toMatchObject({state:'READY'});expect(await fs.readFile(imports.files.filename(row.id))).toEqual(bytes);expect(active).toBe(0);
 });
});
