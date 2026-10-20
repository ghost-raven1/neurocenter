import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readyManifest} from './manifest.mjs';

const require=createRequire(new URL('../../services/catalog-service/package.json',import.meta.url));
/** Operator import retains exact source/recipe SHA bytes before API publication; no base64 transport. */
export async function retainSupplyFiles(assetFile,requestKey,{pool,blobs}={}){
    if(typeof requestKey!=='string'||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(requestKey))throw new Error('Нужен ключ публикации поставки.');
    const [tool]=await readyManifest(assetFile);if(!tool.retainedFiles.length)return {ok:true,retained:[]};
    const ownPool=!pool;
    if(!pool){
        const connectionString=process.env.CATALOG_PG_URL||(process.env.CATALOG_PG_URL_FILE?(await fs.readFile(process.env.CATALOG_PG_URL_FILE,'utf8')).trim():undefined);
        if(!connectionString)throw new Error('Укажите CATALOG_PG_URL или CATALOG_PG_URL_FILE.');
        const {Pool}=require('pg');pool=new Pool({connectionString,max:1,connectionTimeoutMillis:10000});
    }
    try{
        if(!blobs){const {AssetBlobStore}=require('./dist/asset-sources/asset-blob-store.js');blobs=new AssetBlobStore(pool);}
        const retained=await blobs.ingestLocal(tool.retainedFiles,requestKey);
        return {ok:true,retained:retained.map(({sha256,bytes})=>({sha256,bytes}))};
    }finally{if(ownPool)await pool.end();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
    process.umask(0o077);const [assetFile,requestKey,...rest]=process.argv.slice(2);
    Promise.resolve().then(()=>{if(!assetFile||rest.length)throw new Error('Нужны asset.json и ключ публикации.');return retainSupplyFiles(assetFile,requestKey);})
        .then(result=>console.log(JSON.stringify(result))).catch(()=>{console.error('Не удалось удержать точные исходные файлы поставки.');process.exitCode=1;});
}
