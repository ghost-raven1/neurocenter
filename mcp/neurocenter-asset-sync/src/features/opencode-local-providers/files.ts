import fs from 'node:fs/promises';
import path from 'node:path';
import {constants} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {readBoundedSnapshot} from '../../bridge/read-bounded.js';
import {syncDirectory} from '../../bridge/atomic-file.js';
import {enforcePrivateWindowsAcl,assertPrivateWindowsAcl} from '../local-configuration/private-store.js';
export const conflict=()=>Object.assign(Error('Локальные файлы изменились. Перечитайте состояние; другие провайдеры сохранены.'),{code:'GLOBAL_PROVIDER_CONFLICT'});
export const unsafe=()=>Object.assign(Error('Локальный файл или его права небезопасны. Исправьте файл на этом компьютере и перечитайте состояние.'),{code:'GLOBAL_PROVIDER_UNSAFE'});
export interface LocalSnapshot {file:string;text:string|null;fingerprint:string|null;secret:boolean}

/** Global paths are fixed by HOME/XDG, never by the browser. Every ancestor is checked without following links. */
export async function assertPath(file:string,create=false):Promise<void>{
    if(!path.isAbsolute(file)||file.includes('\0'))throw unsafe();
    const directory=path.dirname(file),parsed=path.parse(directory);let current=parsed.root;
    for(const part of directory.slice(parsed.root.length).split(path.sep).filter(Boolean)){
        current=path.join(current,part);let stat;
        try{stat=await fs.lstat(current);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw unsafe();if(!create)return;await fs.mkdir(current,{mode:0o700});await enforcePrivateWindowsAcl(current,true);stat=await fs.lstat(current);}
        if(!stat.isDirectory()||stat.isSymbolicLink())throw unsafe();
    }
    const parent=await fs.lstat(directory);if(process.platform!=='win32'&&parent.uid!==process.getuid?.())throw unsafe();
}
export async function snapshot(file:string,maximum:number,secret:boolean):Promise<LocalSnapshot>{
    await assertPath(file);try{
        const info=await fs.lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||process.platform!=='win32'&&(info.uid!==process.getuid?.()||secret&&(info.mode&0o077)!==0))throw unsafe();
        if(secret)await assertPrivateWindowsAcl(file);
        const value=await readBoundedSnapshot(file,maximum),text=value.bytes.toString('utf8');if(!Buffer.from(text).equals(value.bytes))throw unsafe();
        return {file,text,fingerprint:value.fingerprint,secret};
    }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return{file,text:null,fingerprint:null,secret};throw error;}
}
export async function unchanged(previous:LocalSnapshot,maximum:number):Promise<void>{
    const current=await snapshot(previous.file,maximum,previous.secret);if(current.fingerprint!==previous.fingerprint||current.text!==previous.text)throw conflict();
}
/** A same-user external writer need not honor our lock: fresh byte/inode checks bound detection; no cross-process CAS promise. */
export async function publish(previous:LocalSnapshot,text:string,maximum:number,authorize:()=>Promise<unknown>,verify:()=>Promise<void>):Promise<void>{
    await assertPath(previous.file,true);await unchanged(previous,maximum);const temporary=path.join(path.dirname(previous.file),'.'+randomUUID()+'.tmp');let handle;
    try{
        handle=await fs.open(temporary,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);await handle.writeFile(text);await handle.sync();await handle.close();handle=undefined;await enforcePrivateWindowsAcl(temporary,false);
        await verify();await authorize();await verify();await unchanged(previous,maximum);await assertPath(previous.file);
        await fs.rename(temporary,previous.file);await syncDirectory(path.dirname(previous.file));
    }finally{await handle?.close();await fs.rm(temporary,{force:true});}
}
