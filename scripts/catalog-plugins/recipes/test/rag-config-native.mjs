/** Actual factory and native index exercise global/project precedence and a live key change. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

if (!process.argv[2]) throw new Error('Pass isolated prepared RAG plugin runtime.');
const runtime=await fs.realpath(path.resolve(process.argv[2])),root=await fs.mkdtemp(path.join(os.tmpdir(),'nc-rag-live-config-'));
const home=path.join(root,'home'),project=path.join(root,'project'),oldXdg=process.env.XDG_CONFIG_HOME,originalNow=Date.now;
const load=name=>import(pathToFileURL(path.join(runtime,name)).href),authorizations=[];
let store;
async function closeSession() {
    process.emit('beforeExit',0);
    const deadline=originalNow()+5000,presence=path.join(project,'.opencode','rag-store','neurocenter-session.lock');
    while(await fs.stat(presence).then(()=>true,()=>false)){assert.ok(originalNow()<deadline,'Owned session cleanup timed out');await new Promise(resolve=>setTimeout(resolve,20));}
}
async function fingerprint(directory,prefix='',result={}) {
    for(const entry of await fs.readdir(directory,{withFileTypes:true})){
        const file=path.join(directory,entry.name),relative=prefix+entry.name;
        if(entry.isDirectory())await fingerprint(file,relative+'/',result);
        else {assert.equal(entry.isFile(),true);result[relative]=createHash('sha256').update(await fs.readFile(file)).digest('hex');}
    }
    return result;
}
const provider=http.createServer(async(req,res)=>{
    try {let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw),texts=Array.isArray(body.input)?body.input:[body.input];
        assert.equal(req.url,'/v1/embeddings');assert.equal(body.model,'fixture-live-config');authorizations.push(req.headers.authorization);
        res.setHeader('content-type','application/json');res.end(JSON.stringify({data:texts.map((_,index)=>({index,embedding:[1,0.1,0.2,0.3]}))}));
    }catch{res.writeHead(400);res.end('{"error":"fixture input rejected"}');}
});
try {
    await fs.mkdir(path.join(home,'opencode'),{recursive:true});await fs.mkdir(project);process.env.XDG_CONFIG_HOME=home;
    await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
    const globalFile=path.join(home,'opencode','opencode-rag.json'),projectFile=path.join(project,'opencode-rag.json'),storePath=path.join(project,'.opencode','rag-store');
    const globalValue={embedding:{provider:'openai',model:'fixture-live-config',baseUrl:`http://127.0.0.1:${provider.address().port}/v1`,apiKey:'fixture-live-key-one',vectorDimension:4},
        openCode:{autoIndex:{enabled:true}},autoUpdate:{enabled:true,autoInstall:true},logging:{level:'none'}};
    const originalProject=JSON.stringify({vectorStore:{path:'.opencode/rag-store'},openCode:{autoIndex:{enabled:false}},description:{enabled:false},imageDescription:{enabled:false},decision:{enabled:false},reranking:{enabled:false},indexing:{includeExtensions:['.ts'],minFileSizeBytes:0}});
    await fs.writeFile(globalFile,JSON.stringify(globalValue));await fs.writeFile(projectFile,originalProject);await fs.writeFile(path.join(project,'sample.ts'),'export function calculateInvoiceTotal(amount:number){return amount*2;}\n');
    const {loadWorkspaceConfig,resolveConfigPaths}=await load('upstream/dist/core/config.js');
    const {managedRagConfiguration,readWorkspaceRagConfiguration}=await load('rag-plugin-config.mjs');
    const cfg=managedRagConfiguration(loadWorkspaceConfig(project),readWorkspaceRagConfiguration(resolveConfigPaths(project)),project);
    assert.equal(cfg.openCode.autoIndex.enabled,false);assert.equal(cfg.autoUpdate.enabled,false);assert.equal(cfg.autoUpdate.autoInstall,false);assert.equal(cfg.embedding.apiKey,'fixture-live-key-one');
    const {createVectorStore}=await load('upstream/dist/vectorstore/factory.js'),{createEmbedder}=await load('upstream/dist/embedder/factory.js'),{runIndexPass}=await load('upstream/dist/indexer/pipeline.js');
    await fs.mkdir(storePath,{recursive:true});store=createVectorStore(cfg,storePath,4,project);
    await runIndexPass({cwd:project,storePath,config:cfg,store,embedder:createEmbedder(cfg),dimension:4});await store.close();store=undefined;
    const {default:plugin}=await load('rag-plugin.mjs'),hooks=await plugin({directory:project});
    const context={directory:project,worktree:project,agent:'build',sessionID:'fixture-live-config',messageID:'fixture',abort:new AbortController().signal,metadata(){},ask(){throw new Error('Fixture permission prompt');}};
    const before=authorizations.length,first=await hooks.tool.search_semantic.execute({query:'calculateInvoiceTotal'},context);
    assert.equal(first.metadata.indexed,true);assert.equal(authorizations.at(-1),'Bearer fixture-live-key-one');assert.equal(authorizations.length,before+1);
    globalValue.embedding.apiKey='fixture-live-key-two';const changedGlobal=JSON.stringify(globalValue);await fs.writeFile(globalFile,changedGlobal);
    const changedTime=new Date(originalNow()+2500);await fs.utimes(globalFile,changedTime,changedTime);Date.now=()=>originalNow()+2500;
    const second=await hooks.tool.search_semantic.execute({query:'calculateInvoiceTotal again'},context);
    assert.equal(second.metadata.indexed,true);assert.equal(authorizations.at(-1),'Bearer fixture-live-key-two');assert.equal(authorizations.length,before+2);
    assert.equal(await fs.readFile(projectFile,'utf8'),originalProject);assert.equal(await fs.readFile(globalFile,'utf8'),changedGlobal);
    assert.equal(await fs.stat(path.join(project,'.opencode','opencode-rag.json')).then(()=>true,()=>false),false);
    await closeSession();
    const quirk={id:'quirk:12345678-1234-1234-1234-123456789abc',content:'Keep original',tags:[],confidence:1,lastObserved:'2026-10-29T00:00:00.000Z'};
    await fs.writeFile(path.join(storePath,'quirks.jsonl'),JSON.stringify(quirk)+'\n{broken}\n');
    const beforeCorrupt=await fingerprint(storePath),callsBeforeCorrupt=authorizations.length;
    await assert.rejects(plugin({directory:project}));
    assert.deepEqual(await fingerprint(storePath),beforeCorrupt);assert.equal(authorizations.length,callsBeforeCorrupt);
    const result={status:'passed',scope:'actual-prepared-factory-native-index-live-config',platform:process.platform,architecture:process.arch,
        checks:['Global embedding/provider defaults merge with explicit project autoIndex=false','Unmanaged updater stays disabled despite global true','Actual semantic searches use old then manually changed API key without restart','Global/project JSON bytes are not rewritten by the adapter','Corrupt late Quirk line blocks actual factory before index/session changes; every previous index file hash stays exact'],searchRequests:2,realProfileChanged:false};
    if(process.argv[3])await fs.writeFile(path.resolve(process.argv[3]),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
} finally {
    Date.now=originalNow;await closeSession();
    await store?.close();const{destroyAllPooledConnections}=await load('upstream/dist/embedder/http.js');destroyAllPooledConnections();
    await new Promise(resolve=>{provider.close(resolve);provider.closeAllConnections();});
    if(oldXdg===undefined)delete process.env.XDG_CONFIG_HOME;else process.env.XDG_CONFIG_HOME=oldXdg;
    await fs.rm(root,{recursive:true,force:true});
}
