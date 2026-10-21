import {buildPackage} from '../../catalog-service/src/catalog/bundle-package';
import {hostRuntimeTarget} from '../src/features/mcp-host/host-target';

/** The same native package producer used by the existing full Gateway HTTP acceptance fixture. */
export const researchFixturePackage=(target=hostRuntimeTarget())=>buildPackage({id:'qa-exa',kind:'mcp',name:'QA Exa',version:1},[
 {path:'guide.md',content:'# Approved package\n'},
 {path:'resource.bin',content:Buffer.from([0,1,255]).toString('base64'),encoding:'base64'},
],'2026-10-22T00:00:00Z',{
 transport:'stdio',args:[],extra:{hostedMcp:true,researchMcp:{adapter:'exa',tools:['web_search_exa','web_fetch_exa']},runtimeArtifacts:[{
  target,sha256:'a'.repeat(64),entrypoint:'runtime/server.mjs',compressedBytes:100,unpackedBytes:200,filesCount:1,
 }]},
});
export const researchFixtureTools=()=>({tools:['web_search_exa','web_fetch_exa'].map(name=>({name,description:'Read public evidence',inputSchema:{type:'object',properties:{}},annotations:{readOnlyHint:true,destructiveHint:false}}))});
