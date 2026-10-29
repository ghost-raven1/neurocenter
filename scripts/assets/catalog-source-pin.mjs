import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {PREPARED_SOURCE_INPUTS} from '../catalog-plugins/prepared-source-snapshot.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url)),digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const producerPath='catalog-source/producer.json',lockPath='services/shared/bundled-catalog.lock.json';

/** Maintainer action records the exact public producer closure; current recipe approval never follows a floating repository. */
export async function pinCatalogSource({write=false}={}){
    const files=[];let total=0;
    for(const relative of PREPARED_SOURCE_INPUTS.filter(name=>![producerPath,lockPath].includes(name))){
        const handle=await fs.open(path.join(root,relative),'r');
        try{
            const stat=await handle.stat();if(!stat.isFile()||stat.nlink!==1||stat.size>1024*1024)throw Error('Producer inputs must be regular public files up to1MiB.');
            const bytes=Buffer.alloc(stat.size);let offset=0;
            while(offset<bytes.length){const {bytesRead}=await handle.read(bytes,offset,bytes.length-offset,offset);if(!bytesRead)throw Error('Producer input changed.');offset+=bytesRead;}
            const after=await handle.stat();if(after.size!==stat.size||after.mtimeMs!==stat.mtimeMs||after.ctimeMs!==stat.ctimeMs)throw Error('Producer input changed.');
            total+=bytes.length;if(total>5*1024*1024)throw Error('Producer input closure exceeds5MiB.');
            files.push({path:relative,sha256:digest(bytes),bytes:bytes.length});
        }finally{await handle.close();}
    }
    const producer=Buffer.from(JSON.stringify({schemaVersion:1,files},null,2)+'\n'),manifestPath=path.join(root,'catalog-source/manifest.json');
    const manifest=JSON.parse(await fs.readFile(manifestPath,'utf8'));
    manifest.files=[...manifest.files.filter(file=>file.path!=='producer.json'),{path:'producer.json',sha256:digest(producer),bytes:producer.length}].sort((a,b)=>a.path.localeCompare(b.path));
    const manifestBytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n'),lock=JSON.parse(await fs.readFile(path.join(root,lockPath),'utf8'));
    lock.sha256=digest(manifestBytes);const lockBytes=Buffer.from(JSON.stringify(lock,null,2)+'\n');
    const outputs=[[producerPath,producer],['catalog-source/manifest.json',manifestBytes],[lockPath,lockBytes]];
    for(const [relative,bytes]of outputs){
        if(write)await fs.writeFile(path.join(root,relative),bytes);
        else if(!bytes.equals(await fs.readFile(path.join(root,relative))))throw Error('Producer source pin is stale. Review the change, then run node scripts/assets/catalog-source-pin.mjs --write.');
    }
    return {files:files.length,bytes:total,producerSha256:digest(producer),revision:lock.sha256};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
    const args=process.argv.slice(2);if(args.length!==1||!['--check','--write'].includes(args[0]))throw Error('Use --check or --write after reviewing the app source change.');
    console.log(JSON.stringify(await pinCatalogSource({write:args[0]==='--write'})));
}
