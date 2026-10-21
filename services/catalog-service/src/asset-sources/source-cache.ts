import {ConflictException} from '@nestjs/common';
import {constants} from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {runtimeArtifactDirectory} from '../runtime-artifacts/runtime-artifacts';
import type {AssetSourceTransport} from './source-client';

/** Автономный режим запрещает сетевой fallback, включая проверку новых версий моста. */
export function assetSourceMode(environment:NodeJS.ProcessEnv=process.env):'online'|'offline'{
    const mode=environment.ASSET_SOURCE_MODE||'online';
    if(mode!=='online'&&mode!=='offline')throw new ConflictException('ASSET_SOURCE_MODE должен быть online или offline.');
    return mode;
}

/** Читает SHA-кэш CLI без записи; shared reader повторно проверяет digest фактических байтов. */
export class SourceMetadataCache{
    constructor(private readonly directory=path.join(runtimeArtifactDirectory(),'.asset-source-metadata')){}
    async read(sha:string,maximum:number):Promise<Uint8Array|undefined>{
        if(!/^[a-f0-9]{64}$/.test(sha)||!Number.isSafeInteger(maximum)||maximum<1)throw new ConflictException('Некорректная опись локальной поставки.');
        try{
            const root=await fs.lstat(this.directory);
            if(!root.isDirectory()||root.isSymbolicLink())throw new Error();
            const filename=path.join(this.directory,sha+'.json');
            const handle=await fs.open(filename,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
            try{
                const before=await handle.stat();
                if(!before.isFile()||before.nlink!==1||before.size>maximum)throw new Error();
                const chunks:Buffer[]=[];let count=0;
                for await(const chunk of handle.createReadStream({autoClose:false})){
                    count+=chunk.length;if(count>maximum)throw new Error();chunks.push(chunk);
                }
                const after=await handle.stat(),named=await fs.lstat(filename),rootAfter=await fs.lstat(this.directory);
                if(count!==before.size||before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs
                    ||named.isSymbolicLink()||named.ino!==before.ino||named.dev!==before.dev||rootAfter.ino!==root.ino||rootAfter.dev!==root.dev)throw new Error();
                return Buffer.concat(chunks);
            }finally{await handle.close();}
        }catch(error){
            if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;
            throw new ConflictException('Локальная опись недоступна или повреждена. Перенесите проверенную поставку заново.');
        }
    }
}

export function assetSourceTransport():AssetSourceTransport{
    return assetSourceMode()==='offline'?{offline:true,cache:new SourceMetadataCache()}:{};
}
