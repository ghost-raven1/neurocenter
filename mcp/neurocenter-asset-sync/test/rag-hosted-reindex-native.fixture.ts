import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {vi} from 'vitest';
import {workspaceFixture} from './bridge-fixture.js';
import {canonicalV4,type Package} from '../src/bridge/package.js';
import {hash,hub,stateDir} from '../src/bridge/state.js';
import {projectBindingId,projectInstanceId} from '../src/bridge/workspace.js';
import {install} from '../src/bridge/installer.js';
import * as runtimeCache from '../src/features/runtime-artifacts/cache.js';
import {profileKey} from '../src/features/rag-hosted/profile.js';
import type {IHostedConnectionTransaction,IHostedReindexResult} from '../src/features/rag-hosted/index.js';
import {reindexHostedRag} from '../src/features/rag-hosted/reindex.js';
import {writeRows} from '../src/lib/lancedb.js';
import {row} from './rag-index-fixture.js';

/** Actual CLI/pipeline + native store + bridge commit; artifact delivery is a controlled supply boundary, not archive acceptance. */
export async function nativeReindexFixture(preparedRuntime:string){
    const f=await workspaceFixture();let server:http.Server|undefined,cancelled=false;
    let running:Promise<IHostedReindexResult>|undefined,closing:Promise<void>|undefined;
    // Cancel through the real worker's authorization guard; await its child/stage cleanup before removing its private paths.
    const close=()=>closing??=(async()=>{
        cancelled=true;await running?.catch(()=>undefined);
        if(server){server.closeAllConnections();await new Promise<void>(resolve=>server!.close(()=>resolve()));}
        await fs.rm(f.temporary,{recursive:true,force:true});
    })();
    try{
        const home=path.join(f.temporary,'home');await fs.mkdir(home,{mode:0o700});
        for(const [name,value]of Object.entries({HOME:home,CODEX_HOME:path.join(home,'.codex'),XDG_CONFIG_HOME:path.join(home,'.config'),XDG_DATA_HOME:path.join(home,'.local/share'),XDG_STATE_HOME:path.join(home,'.local/state'),XDG_CACHE_HOME:path.join(home,'.cache')}))vi.stubEnv(name,value);
        const source=await fs.realpath(preparedRuntime),index=JSON.parse(await fs.readFile(path.join(source,'.neurocenter-runtime-index.json'),'utf8'));
        const artifact={...index.artifact,entrypoint:'opencode-rag.mjs',executable:false};
        const disk=await fs.statfs(f.temporary,{bigint:true});
        if(disk.bavail*disk.bsize<BigInt(artifact.unpackedBytes)+128n*1024n**2n+1024n**3n)throw new Error('Native metadata fixture must retain 1GiB free after its runtime clone.');
        const runtime=path.join(stateDir(),'runtime-artifacts',artifact.sha256);
        // Never copy the unused 108MiB archive or write the supplied immutable runtime.
        await fs.cp(source,runtime,{recursive:true,mode:constants.COPYFILE_FICLONE,
            filter:file=>!['.neurocenter-runtime-archive.tar.gz','.neurocenter-runtime-index.json'].includes(path.relative(source,file))});
        for(const name of ['rag-reindex.mjs','rag-errors.mjs','rag-index-corpus.mjs','rag-index-profile.mjs']){
            let current=await fs.readFile(new URL('../../../scripts/catalog-plugins/recipes/adapters/'+name,import.meta.url),'utf8');
            if(name==='rag-index-profile.mjs'){
                const original='../../../../services/shared/rag-index-contract.cjs';
                if(current.split(original).length!==2)throw new Error('Native profile adapter import changed.');
                current=current.replace(original,'./rag-index-contract.cjs');
            }
            const target=path.join(runtime,name);
            try{await fs.chmod(target,0o600);}catch(error){
                if(name!=='rag-index-corpus.mjs'||(error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
            }
            await fs.writeFile(target,current,{mode:0o600});
        }
        const pkg:Package={schemaVersion:5,plugin:{id:'native-rag-file-generation-fixture',name:'Native metadata fixture',kind:'mcp',version:1},
            config:{transport:'local',args:['mcp'],extra:{runtimeArtifacts:[artifact],
                localUi:{schemaVersion:1,application:'opencode-rag',entrypoint:'opencode-rag.mjs',args:['ui','--port','0','--no-open']},
                hostedEmbedding:{schemaVersion:1,profileSchemaVersion:2,reindexSchemaVersion:1}}},files:[],manifest:{sha256:'',filesCount:0}};
        pkg.manifest.sha256=hash(JSON.stringify(canonicalV4({schemaVersion:5,plugin:pkg.plugin,config:pkg.config,files:[]})));
        vi.spyOn(runtimeCache,'resolvePreparedRuntimeArtifact').mockImplementation(async candidate=>{
            if(candidate.plugin.id!==pkg.plugin.id)throw new Error('Only the private fixture package may use this supplied runtime.');
            const selected=runtimeCache.selectedRuntimeArtifact(candidate)!;
            if(selected.sha256!==artifact.sha256)throw new Error('Fixture runtime changed.');
            return{target:selected.target,sha256:selected.sha256,root:runtime,entrypoint:path.join(runtime,selected.entrypoint),executable:false};
        });
        await install('test-project',pkg,async()=>{},async()=>{});
        const input={projectId:'test-project',bindingId:await projectBindingId('test-project'),instanceId:await projectInstanceId('test-project'),pkg};
        const profile={provider:'openai' as const,model:'neurocenter/native-metadata-fixture/sha256/'+'b'.repeat(64),dimension:5};
        const sourceFile=path.join(f.root,'native-recovery.ts'),sourceText='export function syntheticRagRecovery(amount:number){return amount * 3;}\n'.repeat(20);
        await fs.writeFile(sourceFile,sourceText);const store=path.join(f.root,'.opencode/rag_db');
        await writeRows(store,[{...row('legacy-unverified'),filePath:'legacy.md'}],false,3);
        let failDocuments=false;const calls:Array<{documents:boolean;count:number}>=[];
        server=http.createServer(async(request,response)=>{
            try{
                const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(chunk);
                const body=JSON.parse(Buffer.concat(chunks).toString()),texts=Array.isArray(body.input)?body.input:[body.input];
                if(request.method!=='POST'||request.url!=='/v1/embeddings'||body.model!==profile.model||texts.some((text:unknown)=>typeof text!=='string'))throw new Error('Unexpected local fixture request.');
                const documents=texts.some((text:string)=>text.includes('syntheticRagRecovery'));calls.push({documents,count:texts.length});
                response.setHeader('content-type','application/json');
                if(failDocuments&&documents){response.writeHead(422);response.end(JSON.stringify({error:{message:'Synthetic document embedding rejected.'}}));return;}
                response.end(JSON.stringify({model:profile.model,data:texts.map((_:string,index:number)=>({index,embedding:[1,0.2,0.3,0.4,0.5]}))}));
            }catch{response.writeHead(500);response.end('{}');}
        });
        await new Promise<void>(resolve=>server!.listen(0,'127.0.0.1',resolve));
        const port=(server.address() as {port:number}).port,key=profileKey(hub(),f.root,input.instanceId),baseUrl=`http://127.0.0.1:${port}/v1`;
        const after={schemaVersion:2,server:hub(),root:f.root,projectId:input.projectId,bindingId:input.bindingId,instanceId:input.instanceId,relay:{port},
            grants:[{pkg,selection:{revision:2,modelPin:'b'.repeat(64),profile,model:{}},key:'2'.repeat(64)}]};
        const publication:IHostedConnectionTransaction={key,before:null,after,embedding:{profile,baseUrl,apiKey:'2'.repeat(64)}};
        const run=()=>{
            if(cancelled||running)throw new Error('Native fixture runs exactly once before cleanup.');
            running=reindexHostedRag(input,publication,async()=>{if(cancelled)throw new Error('Native fixture cleanup requested.');},async()=>{});
            return running;
        };
        return{...f,input,publication,profile,store,sourceFile,sourceText,calls,failDocuments:()=>{failDocuments=true;},run,close};
    }catch(error){await close();throw error;}
}

/** Byte fingerprints describe only the caller-owned legacy store, including its native manifests. */
export async function indexFileProof(root:string):Promise<Record<string,string>>{
    const files:Record<string,string>={};
    const walk=async(directory:string)=>{for(const entry of await fs.readdir(directory,{withFileTypes:true})){
        const file=path.join(directory,entry.name);if(entry.isDirectory())await walk(file);
        else if(entry.isFile())files[path.relative(root,file)]=hash(await fs.readFile(file));else throw new Error('Unexpected link in native fixture.');
    }};
    await walk(root);return files;
}
