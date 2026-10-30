import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';

/** Only this private application-owned marker requests publication of checked bundled sources. */
export const catalogRebuildRequestPath=root=>path.join(root,'.run/catalog-rebuild/current.json');

async function ordinaryDirectory(directory){
    try{await fs.mkdir(directory,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}
    const info=await fs.lstat(directory);
    if(!info.isDirectory()||info.isSymbolicLink()||await fs.realpath(directory)!==directory||info.uid!==process.getuid?.())throw Error('Каталог запроса пересборки заменён. Прежний запрос сохранён.');
}

/** Publish after bridge preparation; partial or changed local source bytes never replace the last accepted request. */
export async function writeCatalogRebuildRequest({root}){
    if(!path.isAbsolute(root)||await fs.realpath(root)!==root)throw Error('Нужен исходный каталог приложения без ссылок.');
    const require=createRequire(path.join(root,'package.json'));
    const {readBundledCatalog}=require('./services/shared/bundled-catalog.cjs');
    const {makeCatalogRebuildRequest,parseCatalogRebuildRequest}=require('./services/shared/catalog-rebuild-request.cjs');
    const {revision}=await readBundledCatalog(root),request=parseCatalogRebuildRequest(makeCatalogRebuildRequest(revision));
    await ordinaryDirectory(path.join(root,'.run'));const directory=path.join(root,'.run/catalog-rebuild');await ordinaryDirectory(directory);
    const file=catalogRebuildRequestPath(root),temporary=path.join(directory,'.current-'+randomUUID()+'.json');
    const previous=await fs.lstat(file).catch(error=>{if(error.code!=='ENOENT')throw error;});
    if(previous&&(!previous.isFile()||previous.isSymbolicLink()||previous.nlink!==1||previous.uid!==process.getuid?.()))throw Error('Файл запроса пересборки занят посторонними данными.');
    try{
        const handle=await fs.open(temporary,'wx',0o600);
        try{await handle.writeFile(JSON.stringify(request)+'\n');await handle.sync();}finally{await handle.close();}
        await fs.rename(temporary,file);return file;
    }finally{await fs.rm(temporary,{force:true});}
}
