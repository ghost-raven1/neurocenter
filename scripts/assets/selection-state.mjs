import {constants} from 'node:fs';
import {lstat,open,rename,rm,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {safeDirectory} from '../models/bundle-files.mjs';

const validIds=ids=>Array.isArray(ids)&&ids.length<=300&&new Set(ids).size===ids.length
    &&ids.every(id=>typeof id==='string'&&/^[a-z0-9][a-z0-9._-]{0,127}$/.test(id));

/** Small local intent/receipt files never follow links or read unbounded bytes. */
export async function readSelectionFile(root,name){
    let handle;
    try{
        await safeDirectory(root,'.run');
        const filename=path.join(root,'.run',name),named=await lstat(filename);
        if(!named.isFile()||named.isSymbolicLink()||named.nlink!==1||named.size>65536)throw Error('Небезопасный файл выбора ассетов.');
        handle=await open(filename,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
        const before=await handle.stat();
        if(before.ino!==named.ino||before.dev!==named.dev||before.nlink!==1||before.size>65536)throw Error('Выбор ассетов изменился перед чтением.');
        const bytes=await handle.readFile(),after=await handle.stat(),current=await lstat(filename);
        if(after.size!==before.size||after.mtimeMs!==before.mtimeMs||current.ino!==before.ino||current.dev!==before.dev||current.nlink!==1)throw Error('Выбор ассетов изменился во время чтения.');
        return JSON.parse(bytes);
    }catch(error){if(error.code==='ENOENT')return;throw error;}
    finally{await handle?.close();}
}

/** Persist only stable IDs and the source shown to the operator, never commands or credentials. */
export async function saveAssetSelection(root,{pin,ids,withoutModels}){
    if(!validIds(ids))throw Error('Некорректный сохранённый выбор ассетов.');
    await safeDirectory(root,'.run',true);
    const filename=path.join(root,'.run/assets-selection.json'),temporary=filename+'.'+randomUUID();
    try{
        try{const info=await lstat(filename);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1)throw Error('Небезопасный файл выбора ассетов.');}
        catch(error){if(error.code!=='ENOENT')throw error;}
        await writeFile(temporary,JSON.stringify({schemaVersion:1,repository:pin.repository,commit:pin.commit,revision:pin.index.sha256,withoutModels,selected:ids},null,2)+'\n',{flag:'wx',mode:0o600});
        await rename(temporary,filename);
    }finally{await rm(temporary,{force:true});}
}

export async function previousAssetSelection(root){
    const selection=await readSelectionFile(root,'assets-selection.json');
    if(selection!==undefined){
        if(selection?.schemaVersion!==1||!validIds(selection.selected)||typeof selection.repository!=='string'
            ||!/^(?:[a-f0-9]{40}|sha256:[a-f0-9]{64})$/.test(selection.commit||'')||!/^[a-f0-9]{64}$/.test(selection.revision||'')||typeof selection.withoutModels!=='boolean')throw Error('Сохранённый выбор ассетов повреждён.');
        return selection;
    }
    const receipt=await readSelectionFile(root,'assets-ready.json');
    if(receipt?.ok===true&&receipt.mode==='prefetch'&&validIds(receipt.selected))return {...receipt,fromReceipt:true};
}
