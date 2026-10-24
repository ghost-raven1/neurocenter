import {describe,expect,it} from 'vitest';
import {buildPackage} from '../../catalog-service/src/catalog/bundle-package';
import {roleHostedPackage} from '../src/features/system-role-mcp/package';
import {hostRuntimeTarget} from '../src/features/mcp-host/host-target';
const session='00000000-0000-0000-0000-000000000001';
const artifact={target:hostRuntimeTarget(),sha256:'a'.repeat(64),entrypoint:'runtime/server.mjs',compressedBytes:100,unpackedBytes:200,filesCount:1};
describe('generic role server MCP package boundary',()=>{
 it('preserves approved literal arguments without introducing shell expansion',()=>{
  const args=['path with spaces','$HOME','$(never execute)'];
  const pkg=buildPackage({id:'generic',name:'Generic',kind:'mcp',version:1},[],'',{transport:'stdio',args,extra:{hostedMcp:true,runtimeArtifacts:[artifact]}});
  expect(roleHostedPackage(pkg,session).operationArgs).toEqual(args);
 });
 it('uses a proven plugin MCP producer ABI rather than executing the plugin factory',()=>{
  const pkg=buildPackage({id:'arbitrary-id',name:'Any catalogue display name',kind:'plugin',version:1},[],'',{entrypoint:'rag-plugin.mjs',extra:{
   ragCore:{schemaVersion:1,application:'opencode-rag',entrypoint:'opencode-rag.mjs'},hostedEmbedding:{schemaVersion:1,profileSchemaVersion:2,reindexSchemaVersion:1},
   runtimeArtifacts:[{...artifact,entrypoint:'rag-plugin.mjs'}]}});
  expect(roleHostedPackage(pkg,session)).toMatchObject({entrypoint:'opencode-rag.mjs',operationArgs:['mcp'],executable:false});
  const ordinary=buildPackage({id:'opencode-rag',name:'OpenCodeRAG',kind:'plugin',version:1},[],'',{entrypoint:'rag-plugin.mjs',extra:{hostedMcp:true,runtimeArtifacts:[artifact]}});
  expect(()=>roleHostedPackage(ordinary,session)).toThrow();
 });
 it('retains a pinned StreamableHTTP endpoint without requiring a computer or native artifact',()=>{
  const pkg=buildPackage({id:'remote',name:'Remote',kind:'mcp',version:1},[],'',{transport:'remote',url:'https://mcp.example/service',headers:{Accept:'application/json'}});
  expect(roleHostedPackage(pkg,session)).toMatchObject({operationSessionId:session,operationRemote:{url:'https://mcp.example/service',headers:{Accept:'application/json'}}});
 });
 it('rejects credentials in a public manifest and unresolved or local-only configuration',()=>{
  for(const headers of [{Authorization:'Bearer private'},{'X-Api-Key':'private'},{Accept:'{env:SECRET}'}]){
   const pkg=buildPackage({id:'remote',name:'Remote',kind:'mcp',version:1},[],'',{transport:'remote',url:'https://mcp.example/service',headers});
   expect(()=>roleHostedPackage(pkg,session)).toThrow();
  }
 });
});
