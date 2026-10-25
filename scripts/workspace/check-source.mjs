import {execFileSync} from 'node:child_process';
import {sourceSnapshot,sameSource} from './isolated-build-source.mjs';

const reasons=new Set(['INPUT_LIMIT','UNSAFE_SOURCE','SOURCE_CHANGED','CANCELLED']);
/** Reuse bounded current-byte capture; generated outputs never affect check source identity. */
export async function captureCheckSource(root,{enabled=true,signal}={}){
    if(!enabled)return {snapshot:null,reason:'SOURCE_DISABLED'};
    try{
        const top=execFileSync('/usr/bin/git',['--no-optional-locks','-c','core.fsmonitor=false','rev-parse','--show-toplevel'],
            {cwd:root,encoding:'utf8',stdio:['ignore','pipe','ignore'],timeout:5000,maxBuffer:65536}).trim();
        if(top!==root)return {snapshot:null,reason:'NOT_GIT_REPOSITORY'};
    }catch{return {snapshot:null,reason:'NOT_GIT_REPOSITORY'};}
    try{
        const snapshot=await sourceSnapshot(root,{signal});
        snapshot.excluded=Object.fromEntries(Object.entries(snapshot.excluded).filter(([,reason])=>reason!=='generated-or-local-output'));
        return {snapshot,reason:null};
    }catch(error){return {snapshot:null,reason:reasons.has(error.code)?error.code:'SOURCE_UNAVAILABLE'};}
}
const compact=snapshot=>snapshot?{head:snapshot.head,sha256:snapshot.digest,files:snapshot.files,bytes:snapshot.bytes,
    newFiles:snapshot.newFiles,deleted:snapshot.deleted,exclusions:Object.keys(snapshot.excluded).length}:null;
/** Retain only aggregate provenance, without file names or configuration inventories. */
export function checkSourceResult(before,after){
    const known=before.snapshot&&after.snapshot;
    return {status:known?(sameSource(before.snapshot,after.snapshot)?'unchanged':'changed'):'unknown',before:compact(before.snapshot),after:compact(after.snapshot),
        ...(!known?{reason:before.reason||after.reason||'SOURCE_UNAVAILABLE'}:{})};
}
