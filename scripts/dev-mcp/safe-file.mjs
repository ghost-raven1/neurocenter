import path from 'node:path';
import {constants} from 'node:fs';
import {lstat,open,realpath} from 'node:fs/promises';
import {DiagnosticError} from './constants.mjs';

const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino;
const unsafe=()=>new DiagnosticError('UNSAFE_FILE','Use a regular workspace file without symbolic links; retry if the file is being replaced.');

/** Read one bounded regular FD; timestamps describe this checked observation, not a live process. */
export async function readOwnedFile(root,relative,{limit,tail=false}={}){
    if(!Number.isSafeInteger(limit)||limit<1||path.isAbsolute(relative)||relative.split(/[\\/]/).some(part=>!part||part==='.'||part==='..'))throw unsafe();
    const absoluteRoot=path.resolve(root);
    if(await realpath(absoluteRoot)!==absoluteRoot)throw unsafe();
    const parts=relative.split('/'),ancestors=[];
    let current=absoluteRoot;
    for(const component of ['',...parts.slice(0,-1)]){
        if(component)current=path.join(current,component);
        const info=await lstat(current);
        if(info.isSymbolicLink()||!info.isDirectory())throw unsafe();
        ancestors.push({file:current,info});
    }
    const filename=path.join(absoluteRoot,...parts),initial=await lstat(filename);
    if(initial.isSymbolicLink()||!initial.isFile()||initial.nlink!==1)throw unsafe();
    const handle=await open(filename,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try{
        const before=await handle.stat();
        if(!before.isFile()||before.nlink!==1||!same(before,initial))throw unsafe();
        if(!tail&&before.size>limit)throw new DiagnosticError('FILE_TOO_LARGE','The selected report exceeds the supported size limit.');
        const start=tail?Math.max(0,before.size-limit):0,size=Math.min(before.size,limit),buffer=Buffer.alloc(size);
        let offset=0;
        while(offset<size){const result=await handle.read(buffer,offset,size-offset,start+offset);if(!result.bytesRead)break;offset+=result.bytesRead;}
        const after=await handle.stat(),selected=await lstat(filename);
        if(!same(after,before)||!same(after,selected)||selected.isSymbolicLink()||!selected.isFile()||after.nlink!==1||selected.nlink!==1
            ||after.size!==before.size||after.mtimeMs!==before.mtimeMs||offset!==size)throw new DiagnosticError('FILE_CHANGED','The file changed while being read; retry the observation.');
        for(const ancestor of ancestors){const now=await lstat(ancestor.file);if(now.isSymbolicLink()||!now.isDirectory()||!same(now,ancestor.info))throw unsafe();}
        return {text:buffer.toString('utf8'),bytesRead:offset,fileBytes:before.size,truncated:start>0,
            fileModifiedAt:new Date(before.mtimeMs).toISOString(),observedAt:new Date().toISOString()};
    }finally{await handle.close();}
}
