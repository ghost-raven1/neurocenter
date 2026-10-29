import {mkdtemp,mkdir,realpath,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {assetDigest,serializeAsset} from '@neurocenter/asset-contract';
import {syncAssets} from '../assets/sync.mjs';
export const sha=assetDigest;
export const ampleDisk=async()=>({bavail:64n*1024n**3n,bsize:1n});
export const clone=structuredClone;

/** Малые синтетические bytes проходят настоящий новый source contract, без старых supply manifests. */
export async function assetFixture(t){
    const root=await realpath(await mkdtemp(path.join(tmpdir(),'nc asset source ')));t.after(()=>rm(root,{recursive:true,force:true}));
    const payloads=new Map(),calls=[],commit='a'.repeat(40),raw=`https://raw.githubusercontent.com/example/app-source/${commit}/`;
    const source={type:'release',repository:'https://github.com/example/assets',tag:'v1.0.0'},base={schemaVersion:1,source,license:{spdx:'MIT'},compatibility:{packageFormat:5},version:'1.0.0'};
    const toolBytes=Buffer.from('synthetic runtime archive'),toolSha=sha(toolBytes),toolUrl=`https://github.com/example/assets/releases/download/v1.0.0/${toolSha}.tar.gz`;
    const tool={...base,id:'fixture-tool',kind:'plugin',card:{kind:'plugin',name:'Fixture plugin',description:'Описание',revision:'1.0.0',files:[],config:{}},
        delivery:{type:'runtime-artifacts',artifacts:[{url:toolUrl,descriptor:{target:'linux-x64-glibc',sha256:toolSha,compressedBytes:toolBytes.length,unpackedBytes:10,filesCount:1,entrypoint:'index.mjs'}}]}};
    payloads.set(toolUrl,toolBytes);
    const bridgeBytes=Buffer.from('synthetic bridge'),bridgeSha=sha(bridgeBytes),buildId='b'.repeat(64),file='neurocenter-asset-sync-linux-x64-1.0.0.tgz';
    const bridge={...base,id:'fixture-bridge',kind:'bridge',compatibility:{bridgeProtocol:2},card:{name:'Bridge',description:'Описание'},delivery:{type:'bridge-release',
        release:{schemaVersion:1,version:'1.0.0',buildId,release:'bridge-v1.0.0',artifacts:[{file,url:`https://github.com/example/assets/releases/download/bridge-v1.0.0/${file}`,
            metadata:{version:'1.0.0',buildId,target:'linux-x64',nodeVersion:'24.22.0',ragSupported:true,bytes:bridgeBytes.length,sha256:bridgeSha,
                probeEngine:{version:'1.14.48',file:'bin/opencode-probe',sha256:'c'.repeat(64)}}}]}}};
    payloads.set(bridge.delivery.release.artifacts[0].url,bridgeBytes);
    const skill={...base,id:'fixture-skill',kind:'skill',card:{path:'common',slug:'fixture-skill',name:'Skill',body:'Инструкция',meta:{description:'Описание'}},delivery:{type:'inline'}};
    const weights=Buffer.from('synthetic weights'),weightSha=sha(weights),manifest={schemaVersion:2,config:{digest:'sha256:'+weightSha,size:weights.length},layers:[]};
    const manifestBytes=Buffer.from(JSON.stringify(manifest)),manifestSha=sha(manifestBytes),releaseBaseUrl='https://github.com/example/assets/releases/download/models-v1.0.0';
    const part={name:`model-${weightSha}-001.bin`,size:weights.length,sha256:weightSha};payloads.set(releaseBaseUrl+'/'+part.name,weights);
    const model={...base,id:'model-fixture',kind:'model',card:{id:'model-fixture',name:'Model',descriptor:{description:'Описание',capability:'embedding',runtime:'ollama',model:'fixture:1',manifestSha256:manifestSha,dimension:4,source:'builtin'}},
        delivery:{type:'model-bundle',lock:{schemaVersion:1,model:'fixture:1',dimension:4,capability:'embedding',registryManifestUrl:'https://registry.ollama.ai/v2/library/fixture/manifests/1',manifestSha256:manifestSha,manifest,image:'ollama/ollama@sha256:'+'d'.repeat(64)},
            bundle:{schemaVersion:1,kind:'neurocenter-model-bundle',releaseBaseUrl,files:[{path:'models/manifests/registry.ollama.ai/library/fixture/1',size:manifestBytes.length,sha256:manifestSha,inlineBase64:manifestBytes.toString('base64')},
                {path:'models/blobs/sha256-'+weightSha,size:weights.length,sha256:weightSha,parts:[part]}]}}};
    let assets=[tool,bridge,skill,model],index,pin;
    const json=async(relative,value)=>{const filename=path.join(root,relative);await mkdir(path.dirname(filename),{recursive:true});await writeFile(filename,JSON.stringify(value)+'\n');};
    const publish=async(records=assets)=>{
        assets=records;index={schemaVersion:1,assets:[]};
        for(const record of records){const asset=record.asset??record,current=record.current??true,bytes=serializeAsset(asset),relative=`assets/${asset.id}/${asset.version}/asset.json`;
            index.assets.push({id:asset.id,version:asset.version,kind:asset.kind,path:relative,sha256:sha(bytes),current});payloads.set(raw+relative,Buffer.from(bytes));}
        const bytes=Buffer.from(JSON.stringify(index)+'\n');payloads.set(raw+'index.json',bytes);
        pin={schemaVersion:1,repository:'example/app-source',commit,index:{path:'index.json',sha256:sha(bytes)}};await json('services/shared/asset-source.lock.json',pin);
    };
    await publish();
    const request=async(url,options={})=>{url=String(url);calls.push(url);options.signal?.throwIfAborted();const bytes=payloads.get(url);if(!bytes)throw new Error('Unexpected synthetic URL');return new Response(bytes,{headers:{'content-length':String(bytes.length)}});};
    const run=options=>syncAssets({root,environment:{},fetch:request,readDisk:ampleDisk,...options});
    return {root,json,publish,tool,bridge,skill,model,payloads,calls,fetch:request,run,raw,get index(){return index;},get pin(){return pin;},
        blob:sha=>path.join(root,'data/runtime-artifacts/.asset-source-blobs',sha+'.blob'),receipt:path.join(root,'.run/assets-ready.json')};
}
