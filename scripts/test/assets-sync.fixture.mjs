import {mkdtemp,mkdir,realpath,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {packModelBundle} from '../models/bundle.mjs';
import {opencodeVersion} from '../opencode-platforms.mjs';
import {syncAssets} from '../assets/sync.mjs';

export const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export const ampleDisk=async()=>({bavail:64n*1024n**3n,bsize:1n});
export const clone=value=>JSON.parse(JSON.stringify(value));

function archive(bytes) {
    const header=Buffer.alloc(512);header.write('index.mjs');
    const octal=(value,start,length)=>header.write(value.toString(8).padStart(length-1,'0')+'\0',start,length,'ascii');
    octal(0o644,100,8);octal(0,108,8);octal(0,116,8);octal(bytes.length,124,12);octal(0,136,12);header.fill(32,148,156);
    header[156]=48;header.write('ustar\0',257,6,'ascii');header.write('00',263,2,'ascii');
    header.write(header.reduce((sum,byte)=>sum+byte,0).toString(8).padStart(6,'0')+'\0 ',148,8,'ascii');
    return gzipSync(Buffer.concat([header,bytes,Buffer.alloc((512-bytes.length%512)%512),Buffer.alloc(1024)]));
}

export async function assetFixture(t) {
    const root=await realpath(await mkdtemp(path.join(tmpdir(),'nc-assets-')));
    t.after(()=>rm(root,{recursive:true,force:true}));
    const json=async(relative,value)=>{const filename=path.join(root,relative);await mkdir(path.dirname(filename),{recursive:true});await writeFile(filename,JSON.stringify(value));};
    const payloads=new Map(),calls=[],version='9.8.7',buildId='b'.repeat(64),bridgeBytes=Buffer.from('pinned bridge');
    const artifact={file:`neurocenter-asset-sync-linux-x64-${version}.tgz`,metadata:{version,buildId,target:'linux-x64',nodeVersion:'24.22.0',ragSupported:true,
        probeEngine:{version:opencodeVersion,file:'bin/opencode-probe',sha256:'c'.repeat(64)},bytes:bridgeBytes.length,sha256:sha(bridgeBytes)}};
    artifact.url=`https://github.com/ghost-raven1/neurocenter/releases/download/bridge-v${version}/${artifact.file}`;payloads.set(artifact.url,bridgeBytes);
    const bridge={schemaVersion:1,version,buildId,release:'bridge-v'+version,artifacts:[artifact]};
    await json('scripts/bridge-runtime-release.json',bridge);await json('mcp/neurocenter-asset-sync/package.json',{version});
    const source=Buffer.from('export const safe=true;'),tar=archive(source),descriptor={target:'linux-x64-glibc',sha256:sha(tar),compressedBytes:tar.length,unpackedBytes:source.length,filesCount:1,entrypoint:'index.mjs'};
    const url=`https://github.com/ghost-raven1/neurocenter/releases/download/catalog-fixture.1/${descriptor.sha256}.tar.gz`;payloads.set(url,tar);
    const catalog={schemaVersion:1,release:'catalog-fixture.1',tools:[{key:'fixture',publication:{kind:'plugin',name:'Fixture',revision:'1.0.0',files:[],config:{extra:{runtimeArtifacts:[descriptor]}}},legacyOrigins:[],artifacts:[{url,descriptor}]}]};
    await json('scripts/catalog-plugins/catalog-release.json',catalog);
    const sourceModels=path.join(root,'source'),output=path.join(root,'packed'),locks=[],models=[];
    for(const [name,capability] of [['fixture-embedding','embedding'],['fixture-vision','vision']]) {
        const weights=Buffer.from(name+' weights'),digest=sha(weights),manifest={schemaVersion:2,config:{digest:'sha256:'+digest,size:weights.length},layers:[]};
        const manifestBytes=Buffer.from(JSON.stringify(manifest)),manifestSha256=sha(manifestBytes),model=name+':1';
        const lock={schemaVersion:1,model,manifest,manifestSha256};locks.push(lock);
        const lockPath=`scripts/${capability}/model.lock.json`;await json(lockPath,lock);
        models.push({id:'model-'+name,name,descriptor:{description:'fixture',capability,runtime:'ollama',model,manifestSha256,dimension:capability==='embedding'?4:null,source:'builtin'},lock:`../${capability}/model.lock.json`});
        await mkdir(path.join(sourceModels,'models/blobs'),{recursive:true});await writeFile(path.join(sourceModels,'models/blobs/sha256-'+digest),weights);
        const tag=path.join(sourceModels,'models/manifests/registry.ollama.ai/library',name,'1');await mkdir(path.dirname(tag),{recursive:true});await writeFile(tag,manifestBytes);
    }
    await json('scripts/models/model-registry.json',{schemaVersion:1,models});
    const bundle=await packModelBundle({directory:sourceModels,output,locks,baseUrl:'https://github.com/ghost-raven1/neurocenter/releases/download/models-fixture.1',partBytes:8});
    await json('scripts/models/bundle-release.json',bundle);
    for(const file of bundle.files)for(const part of file.parts||[])payloads.set(bundle.releaseBaseUrl+'/'+part.name,await readFile(path.join(output,part.name)));
    const fetch=async(url,options)=>{calls.push(url);options.signal?.throwIfAborted();if(!payloads.has(url))throw new Error('Unexpected URL');return new Response(payloads.get(url),{headers:{'content-length':String(payloads.get(url).length)}});};
    const run=options=>syncAssets({root,environment:{},fetch,readDisk:ampleDisk,...options});
    return {root,json,bridge,catalog,bundle,payloads,calls,fetch,run,locks,receipt:path.join(root,'.run/assets-ready.json')};
}
