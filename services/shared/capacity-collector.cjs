'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {resources,maxAgeMs}=require('./capacity.cjs');
const destination='/capacity/snapshot.json';
function safeNumber(value){if(value<0n||value>BigInt(Number.MAX_SAFE_INTEGER)){throw new Error('unsupported size');}return Number(value);}

/** Пути определены production-топологией, а не пользовательскими или произвольными env-путями. */
async function collectCapacity({root='/volumes',now=Date.now}={}){
    const result={schemaVersion:1,observedAt:now(),resources:{}};
    for(const resource of resources){
        try{
            const base=path.join(root,resource==='wal'?'postgres':resource);
            const directory=resource==='wal'?path.join(base,'pg_wal'):base;
            const actual=await fs.realpath(directory);const realBase=await fs.realpath(base);
            if(actual!==realBase&&!actual.startsWith(realBase+path.sep)){throw new Error('unmounted WAL');}
            const [disk,info]=await Promise.all([fs.statfs(actual,{bigint:true}),fs.stat(actual)]);
            if(!info.isDirectory()){throw new Error('not directory');}
            const item={available:true,filesystem:String(info.dev),totalBytes:safeNumber(disk.blocks*disk.bsize),freeBytes:safeNumber(disk.bavail*disk.bsize)};
            if(resource==='wal'){
                let bytes=0;
                for(const entry of await fs.readdir(actual,{withFileTypes:true})){
                    if(!/^[0-9A-F]{24}(?:\.partial)?$/.test(entry.name)){continue;}
                    const file=await fs.lstat(path.join(actual,entry.name));if(!file.isFile()||file.isSymbolicLink()){throw new Error('WAL type');}bytes+=file.size;
                    if(!Number.isSafeInteger(bytes)){throw new Error('WAL size');}
                }
                item.walBytes=bytes;
            }
            result.resources[resource]=item;
        }catch{result.resources[resource]={available:false};}
    }
    return result;
}
async function publishCapacity(value){
    const temporary=destination+'.'+process.pid+'.partial';
    await fs.mkdir(path.dirname(destination),{recursive:true,mode:0o700});
    try{
        await fs.writeFile(temporary,JSON.stringify(value)+'\n',{flag:'wx',mode:0o600,flush:true});
        await fs.rename(temporary,destination);
    }finally{await fs.rm(temporary,{force:true});}
}
async function main(){
    if(process.argv.includes('--check')){
        const value=JSON.parse(await fs.readFile(destination,'utf8'));
        if(value.schemaVersion!==1||!Number.isSafeInteger(value.observedAt)||Date.now()-value.observedAt>maxAgeMs||resources.some(key=>!value.resources[key]?.available)){throw new Error('Сведения о физических томах недоступны.');}return;
    }
    if(process.argv.includes('--once')){console.log(JSON.stringify(await collectCapacity()));return;}
    let stopping=false;let wake;
    const stop=()=>{stopping=true;wake?.();};process.once('SIGTERM',stop);process.once('SIGINT',stop);
    while(!stopping){
        try{await publishCapacity(await collectCapacity());}catch{console.error('Не удалось опубликовать сведения о физических томах.');}
        if(!stopping){await new Promise(resolve=>{const timer=setTimeout(resolve,15000);wake=()=>{clearTimeout(timer);resolve();};});}
    }
}
module.exports={collectCapacity,publishCapacity};
if(require.main===module){void main().catch(error=>{console.error(error.message);process.exitCode=1;});}
