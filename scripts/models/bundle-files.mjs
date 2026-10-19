import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {mkdir,lstat,open,link,unlink,statfs} from 'node:fs/promises';
import path from 'node:path';

/** Проверяется весь путь от корня файловой системы до хранилища, до чтения и создания каталогов. */
export async function safeDirectory(root,relative='',create=false) {
    const absolute=path.resolve(root),filesystemRoot=path.parse(absolute).root;
    const children=relative.split('/').filter(Boolean);
    for(const part of children) {
        if(part==='.'||part==='..'||part.includes('\\'))throw new Error('Недопустимый путь хранилища моделей.');
    }
    let target=filesystemRoot;
    const base=await lstat(target);
    if(!base.isDirectory()||base.isSymbolicLink())throw new Error('Хранилищу моделей нужен обычный каталог без символической ссылки.');
    const parts=[...absolute.slice(filesystemRoot.length).split(path.sep).filter(Boolean),...children];
    for(const part of parts) {
        target=path.join(target,part);
        let info;
        try {info=await lstat(target);} catch(error) {
            if(error.code!=='ENOENT'||!create)throw error;
            try {await mkdir(target,{mode:0o700});} catch(failure) {if(failure.code!=='EEXIST')throw failure;}
            info=await lstat(target);
        }
        if(!info.isDirectory()||info.isSymbolicLink())throw new Error('Каталог модели заменён символической ссылкой.');
    }
    return target;
}

/** Чтение потоковое: файлы весов не помещаются в память процесса. */
export async function verifyFile(filename,expected) {
    let file;
    try {
        const named=await lstat(filename);
        if(!named.isFile()||named.isSymbolicLink()||named.size!==expected.size)throw new Error('Тип или размер существующего файла модели не совпал. Данные сохранены.');
        file=await open(filename,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
        const before=await file.stat();
        if(!before.isFile()||before.ino!==named.ino||before.dev!==named.dev||before.size!==expected.size)throw new Error('Файл модели изменился перед проверкой.');
        const hash=createHash('sha256');let size=0;
        for await(const chunk of file.createReadStream({autoClose:false})) {size+=chunk.length;if(size>expected.size)throw new Error('Файл модели изменился во время проверки.');hash.update(chunk);}
        const after=await file.stat(),current=await lstat(filename);
        if(size!==expected.size||hash.digest('hex')!==expected.sha256||before.ino!==current.ino||before.dev!==current.dev||!current.isFile()
            ||current.isSymbolicLink()||after.size!==before.size||after.mtimeMs!==before.mtimeMs)throw new Error('SHA существующего файла модели не совпал. Данные сохранены.');
        return true;
    } catch(error) {if(error.code==='ENOENT')return false;throw error;}
    finally {await file?.close();}
}

/** Публикация create-if-absent допускает повтор и параллельный импорт, не перезаписывая другие данные. */
export async function promote(source,target,expected) {
    try {await link(source,target);} catch(error) {if(error.code!=='EEXIST')throw error;}
    if(!await verifyFile(target,expected))throw new Error('Опубликованный файл модели исчез во время проверки.');
    try {await unlink(source);} catch(error) {if(error.code!=='ENOENT')throw error;}
    if(process.platform!=='win32') {
        const folder=await open(path.dirname(target),constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
        try {await folder.sync();} finally {await folder.close();}
    }
}

export async function ensureSpace(directory,bytes,readDisk=statfs) {
    if(!bytes)return;
    const disk=await readDisk(directory,{bigint:true});
    if(disk.bavail*disk.bsize<BigInt(bytes+1024**3))throw new Error('Недостаточно места для поставки моделей с резервом 1 ГиБ. Существующие данные сохранены.');
}

function allowedRedirect(value) {
    let url;try {url=new URL(value);} catch {throw new Error('Некорректный адрес загрузки поставки.');}
    if(url.protocol!=='https:'||url.username||url.password||url.port||!['github.com','release-assets.githubusercontent.com','objects.githubusercontent.com'].includes(url.hostname))throw new Error('Перенаправление загрузки модели ведёт за пределы GitHub.');
    return url;
}

/** Только собственный release и CDN GitHub; каждый ответ ограничен закреплённым размером и SHA. */
export async function downloadPart(url,target,part,{fetch:request=fetch,signal,onBytes=()=>{}}={}) {
    let response;let current=url;
    const deadline=AbortSignal.any([AbortSignal.timeout(15*60*1000),...(signal?[signal]:[])]);
    for(let hop=0;hop<4;hop++) {
        allowedRedirect(current);
        response=await request(current,{redirect:'manual',signal:deadline});
        if(![301,302,303,307,308].includes(response.status))break;
        const location=response.headers.get('location');await response.body?.cancel();
        if(!location||hop===3)throw new Error('Не удалось получить часть поставки модели с GitHub.');
        current=new URL(location,current).href;
    }
    if(!response?.ok||!response.body) {await response?.body?.cancel();throw new Error(`GitHub не выдал часть модели (HTTP ${response?.status||0}).`);}
    const length=response.headers.get('content-length');
    if(length!==null&&length!==String(part.size)) {await response.body.cancel();throw new Error('Размер ответа GitHub не совпал с описью модели.');}
    const file=await open(target,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    const reader=response.body.getReader(),hash=createHash('sha256');let size=0;
    try {
        while(true) {
            const chunk=await reader.read();if(chunk.done)break;
            size+=chunk.value.length;if(size>part.size)throw new Error('Загрузка модели превысила закреплённый размер.');
            hash.update(chunk.value);await file.writeFile(chunk.value);await onBytes(chunk.value.length);
        }
        if(size!==part.size||hash.digest('hex')!==part.sha256)throw new Error('SHA загруженной части модели не совпал.');
        await file.sync();
    } finally {await reader.cancel().catch(()=>undefined);reader.releaseLock();await file.close();}
}
