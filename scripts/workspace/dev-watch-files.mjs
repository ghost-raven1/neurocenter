import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {watchPackageSelection} from './dev-watch-plan.mjs';
import {sourceSnapshot,linkDependencies,artifactTree} from './isolated-build-source.mjs';
export const watchDirectory=root=>path.join(root,'.run/dev-watch');
/** Atomic, private metadata never includes environment values, raw compiler output or credentials. */
export async function writeWatchFile(root,name,value){const directory=watchDirectory(root);await fs.mkdir(directory,{recursive:true,mode:0o700});const file=path.join(directory,name),temporary=file+'.'+randomUUID();try{await fs.writeFile(temporary,JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});await fs.rename(temporary,file);}finally{await fs.rm(temporary,{force:true});}}
export async function readWatchFile(root,name){try{return JSON.parse(await fs.readFile(path.join(watchDirectory(root),name),'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}}
/** Freeze the already-built initial runtime so a later failed restart can use its previous shared bytes. */
export async function initialWatchGeneration(root,signal,options){
    const selection=watchPackageSelection(options);
    const folder=path.join(watchDirectory(root),'generations',randomUUID()),repository=path.join(folder,'repository');await fs.mkdir(repository,{recursive:true,mode:0o700});
    try{const source=await sourceSnapshot(root,{destination:repository,signal});if(source.bytes>64*1024**2)throw Error('WATCH_RUNTIME_INPUT_LIMIT');await linkDependencies(root,repository,selection);
        for(const [,relative,entry]of selection){signal?.throwIfAborted();const source=await fs.realpath(path.join(root,relative,'dist'));const artifacts=await artifactTree(source);if(!artifacts.files[entry])throw Error('WATCH_INITIAL_BUILD_MISSING');await fs.cp(source,path.join(repository,relative,'dist'),{recursive:true,dereference:false});}
        return {folder,repository,sourceSha256:source.digest};
    }catch(error){await fs.rm(folder,{recursive:true,force:true});throw error;}
}
/** Keep the active immutable repository; large transient build manifests/logs are removed after use. */
export async function publishWatchGeneration(root,result){
    const folder=path.join(watchDirectory(root),'generations',path.basename(path.dirname(result.repository)));await fs.mkdir(folder,{recursive:true,mode:0o700});
    await fs.rename(result.repository,path.join(folder,'repository'));return {folder,repository:path.join(folder,'repository'),sourceSha256:result.inputs?.sha256??null};
}
export async function pruneWatchGenerations(root,keep){
    const directory=path.join(watchDirectory(root),'generations'),names=await fs.readdir(directory).catch(error=>{if(error.code==='ENOENT')return [];throw error;});
    for(const name of names)if(/^[a-f0-9-]{36}$/.test(name)&&!keep.has(name))await fs.rm(path.join(directory,name),{recursive:true,force:true});
}
export function entryGeneration(root,entry){const relative=path.relative(path.join(watchDirectory(root),'generations'),entry??'');const [id,repository]=relative.split(path.sep);return /^[a-f0-9-]{36}$/.test(id||'')&&repository==='repository'?id:undefined;}
export async function cleanupWatchBuild(root,result){
    const folder=path.dirname(result.receipt);if(path.dirname(folder)!==path.join(root,'.run/isolated-build'))throw Error('WATCH_UNSAFE_BUILD');
    await writeWatchFile(root,'last-build.json',{ok:result.ok,finishedAt:result.finishedAt,selected:result.selectedPackages,source:result.inputs?.sha256,primaryFailure:result.primaryFailure?{code:result.primaryFailure.code}:null});
    if(!result.ok){const failure=path.join(watchDirectory(root),'last-failure');await fs.rm(failure,{recursive:true,force:true});await fs.mkdir(failure,{mode:0o700});
        for(const build of result.builds??[]){if(!/^[a-z-]+$/.test(build.id))continue;const file=path.join(folder,build.id+'.log');try{const handle=await fs.open(file,'r');try{const size=(await handle.stat()).size,bytes=Buffer.alloc(Math.min(size,256*1024));await handle.read(bytes,0,bytes.length,Math.max(0,size-bytes.length));await fs.writeFile(path.join(failure,build.id+'.log'),bytes,{mode:0o600});}finally{await handle.close();}}catch(error){if(error.code!=='ENOENT')throw error;}}
    }
    await fs.rm(folder,{recursive:true,force:true});
}
