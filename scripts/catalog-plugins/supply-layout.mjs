import {constants} from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import paths from '../../services/shared/tool-supply-paths.cjs';
export const {TOOL_SOURCE_MAX_BYTES,toolRuntimePath,toolSourcePath,assertToolSupplyLayout:assertSupplyLayout}=paths;

/** No alternate directory layout, symlink parent, hardlink, or path escaping is accepted. */
export async function supplyFile(directory,relative){
    if(typeof relative!=='string'||!relative||relative.includes('\\')||path.posix.isAbsolute(relative)||relative.split('/').some(part=>!part||part==='.'||part==='..'))throw new Error('Небезопасный путь файла поставки.');
    let current=directory;for(const part of ['',...relative.split('/').slice(0,-1)]){if(part)current=path.join(current,part);const info=await fs.lstat(current);if(!info.isDirectory()||info.isSymbolicLink())throw new Error('Каталоги поставки не должны быть ссылками.');}
    return path.join(directory,relative);
}

/** Verify opaque bytes with bounded memory; extension never implies UTF-8 or JSON. */
export async function inspectSupplyBytes(directory,relative,sha256,maximum,expectedBytes){
    const filename=await supplyFile(directory,relative),handle=await fs.open(filename,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try{
        const before=await handle.stat();if(!before.isFile()||before.nlink!==1||before.size<1||before.size>maximum||expectedBytes!==undefined&&before.size!==expectedBytes)throw new Error('Source/recipe snapshot type/bytes не совпали или превышают предел поставки.');
        const hash=createHash('sha256');let bytes=0;
        for await(const chunk of handle.createReadStream({autoClose:false})){bytes+=chunk.length;if(bytes>before.size)throw new Error('Source/recipe snapshot вырос при чтении.');hash.update(chunk);}
        const after=await handle.stat(),named=await fs.lstat(filename);
        if(bytes!==before.size||hash.digest('hex')!==sha256||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ino!==named.ino||before.dev!==named.dev||named.isSymbolicLink())throw new Error('Source/recipe snapshot SHA/bytes изменились.');
        return {archivePath:filename,sha256,bytes,filename:path.posix.basename(relative)};
    }finally{await handle.close();}
}
