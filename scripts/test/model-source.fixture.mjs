import {mkdtemp,mkdir,writeFile,readFile,rm,copyFile,realpath} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {sha256} from '../models/bundle-manifest.mjs';
import {packModelBundle} from '../models/bundle.mjs';
import {prepareModelSupply} from '../models/publish.mjs';

export const repository=fileURLToPath(new URL('../../',import.meta.url));
export const ampleDisk=async()=>({bavail:64n*1024n**3n,bsize:1n});
export async function modelSourceFixture(t,{weight='verified-model-weights',name='fixture-embedding:1'}={}){
    const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'nc new model asset ')));t.after(()=>rm(root,{recursive:true,force:true}));
    await copyFile(path.join(repository,'compose.embedding.yml'),path.join(root,'compose.embedding.yml'));
    const directory=path.join(root,'source'),blobs=path.join(root,'blobs'),target=path.join(root,'target'),output=path.join(root,'prepared');
    await mkdir(path.join(directory,'models/blobs'),{recursive:true});await mkdir(blobs);
    const weights=Buffer.from(weight),config=Buffer.from('{"public":true}');
    for(const bytes of [weights,config])await writeFile(path.join(directory,'models/blobs','sha256-'+sha256(bytes)),bytes);
    const manifest={schemaVersion:2,config:{digest:'sha256:'+sha256(config),size:config.length},layers:[{digest:'sha256:'+sha256(weights),size:weights.length}]};
    const [model,tag]=name.split(':'),manifestDirectory=path.join(directory,'models/manifests/registry.ollama.ai',model.includes('/')?model:'library/'+model);
    await mkdir(manifestDirectory,{recursive:true});await writeFile(path.join(manifestDirectory,tag),JSON.stringify(manifest));
    await writeFile(path.join(directory,'id_ed25519'),'PRIVATE KEY MUST NOT BE READ');
    const options={root,directory,output,model:name,release:'models-fixture-v1'};
    const dependencies={readDisk:ampleDisk,pack:options=>packModelBundle({...options,partBytes:8})};
    const prepare=(values={},deps={})=>prepareModelSupply({...options,...values},{...dependencies,...deps});
    const cached=async()=>{const asset=JSON.parse(await readFile(path.join(output,'asset.json'),'utf8'));for(const file of asset.delivery.bundle.files)for(const part of file.parts||[])await copyFile(path.join(output,part.name),path.join(blobs,part.sha256+'.blob'));return asset;};
    return {root,directory,blobs,target,output,manifest,options,dependencies,prepare,cached};
}
