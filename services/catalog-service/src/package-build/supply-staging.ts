import {constants} from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {hostname} from 'node:os';

const marker='owner.json',lifetime=15*60*1000;
/** The HTTP hard deadline is five minutes; identified stages expire after three deadlines, across replica restarts. */
export async function cleanStaleSupplyStages(root:string):Promise<void>{
    const now=Date.now(),entries=await fs.opendir(root);let inspected=0;
    for await(const entry of entries){
        if(++inspected>64)break;if(!entry.isDirectory()||!/^export-[A-Za-z0-9]{6}$/.test(entry.name))continue;
        const stage=path.join(root,entry.name);let handle:fs.FileHandle|undefined;
        try{
            const directory=await fs.lstat(stage);if(!directory.isDirectory()||directory.isSymbolicLink()||now-directory.mtimeMs<lifetime)continue;
            handle=await fs.open(path.join(stage,marker),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
            const info=await handle.stat();if(!info.isFile()||info.nlink!==1||info.size<1||info.size>1024||now-info.mtimeMs<lifetime)continue;
            const owner=JSON.parse(await handle.readFile('utf8')) as {version:number;host:string;createdAt:number};
            if(Object.keys(owner).sort().join(',')!=='createdAt,host,version'||owner.version!==1||typeof owner.host!=='string'||!owner.host||owner.host.length>256
                ||!Number.isSafeInteger(owner.createdAt)||owner.createdAt<1||now-owner.createdAt<lifetime)continue;
            await handle.close();handle=undefined;await fs.rm(stage,{recursive:true,force:true});
        }catch{/* An unknown or concurrently removed stage is never grounds to touch other files. */}
        finally{await handle?.close();}
    }
}
/** Ownership metadata lives outside archive contents and contains no source paths or credentials. */
export async function markSupplyStage(stage:string):Promise<void>{
    await fs.writeFile(path.join(stage,marker),JSON.stringify({version:1,host:hostname(),createdAt:Date.now()}),{flag:'wx',mode:0o600});
}
