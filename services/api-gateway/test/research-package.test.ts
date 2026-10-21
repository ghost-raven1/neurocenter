import {createHash} from 'node:crypto';
import {describe,expect,it} from 'vitest';
import {buildPackage} from '../../catalog-service/src/catalog/bundle-package';
import {publicationHash} from '../../catalog-service/src/publication/publication-validation';
import {researchPackage} from '../src/features/research-mcp/research-package';
import {hostRuntimeTarget} from '../src/features/mcp-host/host-target';
import {researchFixturePackage} from './research-contract.fixture';
const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');

describe('Approved native research package proof',()=>{
 it('accepts exact text/binary resources, preserves approved runtime limits, and isolates each request',()=>{
  const pkg=researchFixturePackage(),first=researchPackage(pkg),second=researchPackage(pkg);
  expect(first).toMatchObject({artifactSha256:'a'.repeat(64),entrypoint:'runtime/server.mjs',executable:false,name:'QA Exa',compressedBytes:100,unpackedBytes:200,filesCount:1});
  expect(first.researchSessionId).toMatch(/^[a-f0-9-]{36}$/);expect(second.researchSessionId).not.toBe(first.researchSessionId);expect(first.exp).toBeGreaterThan(Date.now());expect(first.exp).toBeLessThanOrEqual(Date.now()+300000);
 });
 it('is independent of file ordering, supports empty resource sets and explicit native execution metadata',()=>{
  const input=researchFixturePackage(),config=structuredClone(input.config)!;(config.extra!.runtimeArtifacts as Array<{executable?:boolean}>)[0].executable=true;
  const a=buildPackage(input.plugin,[],'',config);expect(researchPackage(a).executable).toBe(true);
  input.files.reverse();expect(researchPackage(input).artifactSha256).toBe('a'.repeat(64));
 });
 it.each([
  (p:any)=>p.schemaVersion=4,(p:any)=>p.plugin=null,(p:any)=>p.plugin.kind='plugin',(p:any)=>p.plugin.id='',(p:any)=>p.plugin.id=1,
  (p:any)=>p.plugin.name='',(p:any)=>p.plugin.name=2,(p:any)=>p.plugin.name='x'.repeat(201),(p:any)=>p.plugin.version=0,(p:any)=>p.plugin.version=1.5,
  (p:any)=>p.config=null,(p:any)=>p.config.transport='remote',(p:any)=>p.config.extra=null,(p:any)=>p.config.extra.hostedMcp=false,
  (p:any)=>p.manifest=null,(p:any)=>p.manifest.sha256='invalid',(p:any)=>p.manifest.filesCount++, (p:any)=>p.files=null,
  (p:any)=>p.config.extra.researchMcp=null,(p:any)=>p.config.extra.researchMcp.adapter='unapproved',(p:any)=>p.config.extra.researchMcp.tools='web_search_exa',
  (p:any)=>p.config.extra.researchMcp.tools.push('execute_shell'),(p:any)=>p.config.extra.researchMcp.tools[1]='execute_shell',
  (p:any)=>p.files[0]=null,(p:any)=>p.files[0].path='',(p:any)=>p.files[0].path=1,(p:any)=>p.files[1].path=p.files[0].path,
  (p:any)=>p.files[0].content=1,(p:any)=>p.files[0].encoding='gzip',(p:any)=>p.files[0].size=-1,(p:any)=>p.files[0].size=1.5,(p:any)=>p.files[0].size=1024**2+1,
  (p:any)=>p.files[0].content='modified',(p:any)=>p.files[0].sha256='b'.repeat(64),
  (p:any)=>{p.files[1].content='YQ';p.files[1].size=1;p.files[1].sha256=digest(Buffer.from('a'));},
  (p:any)=>p.manifest.sha256='b'.repeat(64),
 ])('rejects mutated proof or unsupported delivery %# before selecting a runtime',change=>{const pkg=researchFixturePackage();change(pkg);expect(()=>researchPackage(pkg)).toThrow(expect.objectContaining({status:400}));});
 it.each([null,undefined,[],{},'not a package'])('rejects invalid package framing %#',pkg=>{expect(()=>researchPackage(pkg)).toThrow(expect.objectContaining({status:400}));});
 it('rejects invalid or missing host artifacts even when the package manifest itself is recomputed',()=>{
  const original=researchFixturePackage();for(const value of [undefined,[],[{target:hostRuntimeTarget(),sha256:'invalid'}]]){
   const pkg=structuredClone(original);
   const proof=()=>publicationHash({schemaVersion:pkg.schemaVersion,plugin:pkg.plugin,config:pkg.config,files:pkg.files.map(({path,size,sha256,encoding})=>({path,size,sha256,...(encoding?{encoding}:{})})).sort((a,b)=>a.path.localeCompare(b.path))});
   expect(proof()).toBe(pkg.manifest.sha256);
   pkg.config!.extra!.runtimeArtifacts=value as never;pkg.manifest.sha256=proof();
   // A forged matching checksum cannot make an invalid or absent runtime descriptor executable.
   expect(()=>researchPackage(pkg)).toThrow(expect.objectContaining({status:400}));
  }
  expect(()=>researchPackage(original,'not-the-approved-host')).toThrow(expect.objectContaining({status:400}));
 });
});
