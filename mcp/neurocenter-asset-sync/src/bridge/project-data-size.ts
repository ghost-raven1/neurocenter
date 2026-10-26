import fs from 'node:fs/promises';
import path from 'node:path';

export interface ProjectDataSize {
    scope:'opencode';
    bytes:number|null;
    measuredAt:string;
    error?:'unavailable'|'limit-exceeded';
}
type Measurement=Pick<ProjectDataSize,'bytes'|'error'>;
interface Request {key:string;root:string;isCurrent:()=>Promise<boolean>}
interface Walk {entries:number;stopped:boolean;deadline:number}
const MAX_ENTRIES=10000,MAX_DEPTH=32,TIMEOUT_MS=1000;
const REFRESH_MS=30000,MAX_AGE_MS=60000,MAX_PENDING=128,MAX_CACHED=256;
class LimitExceeded extends Error {}

function budget(walk:Walk):void {
    if(walk.stopped||performance.now()>=walk.deadline)throw new LimitExceeded();
}

async function directoryBytes(directory:string,depth:number,walk:Walk):Promise<number> {
    budget(walk);
    if(depth>MAX_DEPTH)throw new LimitExceeded();
    const before=await fs.lstat(directory);budget(walk);
    if(!before.isDirectory()||before.isSymbolicLink())throw new Error('unavailable');
    const entries=await fs.opendir(directory);
    if(walk.stopped){await entries.close();throw new LimitExceeded();}
    let bytes=0;
    for await(const entry of entries){
        budget(walk);
        if(++walk.entries>MAX_ENTRIES)throw new LimitExceeded();
        const file=path.join(directory,entry.name),stat=await fs.lstat(file);budget(walk);
        if(stat.isSymbolicLink())continue;
        if(stat.isDirectory())bytes+=await directoryBytes(file,depth+1,walk);
        else if(stat.isFile())bytes+=stat.size;
        if(!Number.isSafeInteger(bytes))throw new LimitExceeded();
    }
    const after=await fs.lstat(directory);budget(walk);
    if(!after.isDirectory()||after.dev!==before.dev||after.ino!==before.ino)throw new Error('unavailable');
    return bytes;
}

function startMeasurement(root:string):{result:Promise<Measurement>;settled:Promise<void>} {
    const walk:Walk={entries:0,stopped:false,deadline:performance.now()+TIMEOUT_MS};
    let timer:ReturnType<typeof setTimeout>|undefined;
    const timeout=new Promise<Measurement>(resolve=>{timer=setTimeout(()=>{walk.stopped=true;resolve({bytes:null,error:'limit-exceeded'});},TIMEOUT_MS);});
    const scan=async():Promise<Measurement>=>{
        try{
            const before=await fs.lstat(root);budget(walk);
            if(!before.isDirectory()||before.isSymbolicLink())throw new Error('unavailable');
            const directory=path.join(root,'.opencode');
            try{await fs.lstat(directory);}
            catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
                const after=await fs.lstat(root);budget(walk);
                if(!after.isDirectory()||after.dev!==before.dev||after.ino!==before.ino)throw new Error('unavailable');
                return {bytes:0};
            }
            return {bytes:await directoryBytes(directory,0,walk)};
        }catch(error){return {bytes:null,error:error instanceof LimitExceeded?'limit-exceeded':'unavailable'};}
    };
    const reading=scan();
    return {result:Promise.race([reading,timeout]).finally(()=>{if(timer)clearTimeout(timer);}),settled:reading.then(()=>undefined)};
}

/** Reads metadata only; an incomplete traversal never becomes a partial successful size. */
export function measureProjectDataSize(root:string):Promise<Measurement> {return startMeasurement(root).result;}

/** The physical scan keeps its slot after a deadline, so stuck OS I/O cannot accumulate across heartbeats. */
export function createProjectDataSizeReporter(measure?:(root:string)=>Promise<Measurement>) {
    const cache=new Map<string,{at:number;value:ProjectDataSize}>(),queue=new Map<string,Request>(),pending=new Set<string>();
    let running=false;
    const drain=async():Promise<void>=>{
        if(running)return;
        running=true;
        try{
            while(queue.size){
                const [key,request]=queue.entries().next().value!;queue.delete(key);
                let scanning:ReturnType<typeof startMeasurement>|undefined;
                try{
                    if(!await request.isCurrent()){cache.delete(key);continue;}
                    if(measure){const result=measure(request.root);scanning={result,settled:result.then(()=>undefined)};}
                    else scanning=startMeasurement(request.root);
                    const result=await scanning.result,at=Date.now();
                    if(!await request.isCurrent()){cache.delete(key);continue;}
                    cache.delete(key);cache.set(key,{at,value:{scope:'opencode',...result,measuredAt:new Date(at).toISOString()}});
                    if(cache.size>MAX_CACHED)cache.delete(cache.keys().next().value!);
                }catch{cache.delete(key);}
                finally{try{await scanning?.settled;}catch{/* The measurement failure was already handled. */}pending.delete(key);}
            }
        }finally{running=false;}
    };
    return (request:Request):ProjectDataSize|undefined=>{
        const cached=cache.get(request.key),age=cached?Date.now()-cached.at:Infinity;
        if((age<0||age>=REFRESH_MS)&&!pending.has(request.key)&&pending.size<MAX_PENDING){
            pending.add(request.key);queue.set(request.key,request);void drain();
        }
        return age>=0&&age<MAX_AGE_MS?cached?.value:undefined;
    };
}

export const projectDataSizeReport=createProjectDataSizeReporter();
