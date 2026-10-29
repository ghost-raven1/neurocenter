import fs from 'node:fs/promises';
import path from 'node:path';
import {buildPackages} from './isolated-build-source.mjs';
export const watchService={name:'source-watch',label:'Пересборка исходников',dir:'.',entry:'scripts/workspace/dev-watch-guardian.mjs'};
export const servicePackages={bridge:'oauth2-bridge',catalog:'catalog-service',flags:'feature-flags-service',skills:'skills-service',rag:'rag-sync-service',gateway:'api-gateway'};
export const backendSelection=buildPackages.filter(([id])=>id!=='frontend');
/** Core watcher neither requires nor rebuilds the optional Native bridge package. */
export const watchPackageSelection=({nativeEnabled=true}={})=>backendSelection.filter(([id])=>nativeEnabled||id!=='bridge');
const ignored=new Set(['node_modules','dist','.git','.run','test','coverage']);
/** Watch only executable/configuration inputs; Vite already owns frontend HMR. */
export async function watchSnapshot(root,options){
    const result=new Map();let count=0;
    const walk=async(relative,depth=0)=>{
        if(depth>24)throw Error('WATCH_INPUT_LIMIT');
        const entries=await fs.readdir(path.join(root,relative),{withFileTypes:true}).catch(error=>{if(error.code==='ENOENT')return [];throw error;});
        for(const entry of entries){if(++count>20000)throw Error('WATCH_INPUT_LIMIT');if(entry.isSymbolicLink()||ignored.has(entry.name))continue;const name=relative+'/'+entry.name;
            if(entry.isDirectory())await walk(name,depth+1);else if(entry.isFile()){const info=await fs.lstat(path.join(root,name),{bigint:true});result.set(name,[info.ino,info.size,info.mtimeNs,info.ctimeNs].join(':'));}
        }
    };
    for(const [,folder]of watchPackageSelection(options)){for(const suffix of ['src','content'])await walk(folder+'/'+suffix);for(const name of ['package.json','package-lock.json','tsconfig.json','tsconfig.build.json','nest-cli.json','scripts/build.mjs']){const relative=folder+'/'+name;try{const s=await fs.lstat(path.join(root,relative),{bigint:true});if(s.isFile()&&!s.isSymbolicLink())result.set(relative,[s.ino,s.size,s.mtimeNs,s.ctimeNs].join(':'));}catch(error){if(error.code!=='ENOENT')throw error;}}}
    await walk('services/shared');await walk('scripts/catalog-plugins');return result;
}
export function changedWatchInputs(before,after){return [...new Set([...before.keys(),...after.keys()])].filter(name=>before.get(name)!==after.get(name));}
/** Recipes belong to the Catalog producer; shared/MCP changes include their backend consumers. */
export function affectedPackages(files,options){
    const selection=watchPackageSelection(options),ids=new Set();for(const file of files){if(file.startsWith('scripts/catalog-plugins/'))ids.add('catalog-service');else if(file.startsWith('services/shared/'))for(const [id]of selection)ids.add(id);else for(const [id,folder]of selection)if(file.startsWith(folder+'/'))ids.add(id);}
    if(ids.has('bridge')){ids.add('catalog-service');ids.add('rag-sync-service');}return selection.filter(([id])=>ids.has(id));
}
