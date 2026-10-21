import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import {createRequire} from 'node:module';
import type {Connection,Table} from '@lancedb/lancedb';
import {assertFlatNamespace} from './namespace.js';
import {physicalSnapshotTableNames} from './files.js';
const snapshotConnect=async(store:string)=>(await import('@lancedb/lancedb')).connect(store,{manifestEnabled:false});
import {readBoundedUtf8} from '../../bridge/read-bounded.js';
import {snapshotCanonicalJson,snapshotSchemaHash,type SnapshotTable} from './contract.js';

const changed=()=>new Error('Таблицы LanceDB изменились во время снимка. Публикация не завершена.');
/** SDK 0.29 initializes __manifest even with manifestEnabled:false; all such writes stay in scratch. */
async function readOnlyConnection(store:string,names:string[]){
 const scratch=await fs.mkdtemp(path.join(os.tmpdir(),'nc-snapshot-sdk-'));let database:Connection|undefined;
 try{for(const name of names)await fs.symlink(path.join(store,name+'.lance'),path.join(scratch,name+'.lance'),'dir');database=await snapshotConnect(scratch);
  return {database,async close(){try{database?.close();}finally{await fs.rm(scratch,{recursive:true,force:true});}}};
 }catch(error){database?.close();await fs.rm(scratch,{recursive:true,force:true});throw error;}
}

/** The portable image is tied to the actual SDK, not a version label guessed from the table schema. */
async function assertSdkVersion(){
    const entry=createRequire(import.meta.url).resolve('@lancedb/lancedb');
    const info=JSON.parse(await readBoundedUtf8(path.join(path.dirname(entry),'../package.json'),64*1024)) as {name?:string;version?:string};
    if(info.name!=='@lancedb/lancedb'||info.version!=='0.29.0')throw new Error('Полный образ требует LanceDB SDK 0.29.0. Обновите поддерживаемую поставку моста.');
}
/** Explicit SDK pagination never silently truncates the database to the default first page. */
export async function allSnapshotTableNames(database:Pick<Connection,'tableNames'>,checkpoint:()=>Promise<void>):Promise<string[]>{
    const names:string[]=[];let after:string|undefined;
    for(;;){await checkpoint();const page=await database.tableNames({limit:128,...after?{startAfter:after}:{}});
        if(!Array.isArray(page)||page.length>128)throw changed();if(!page.length)break;
        for(const name of page){if(typeof name!=='string'||!/^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,127}$/.test(name)||after!==undefined&&name<=after||names.some(value=>value.toLowerCase()===name.toLowerCase())||names.length>=512)throw changed();names.push(name);after=name;}
    }
    if(!names.length)throw new Error('В LanceDB пока нет таблиц. Пустое хранилище не выдаётся за полный снимок.');return names;
}
async function metadata(name:string,table:Table):Promise<SnapshotTable>{
    const version=await table.version(),rows=await table.countRows(),schemaSha256=snapshotSchemaHash(await table.schema());
    if(!Number.isSafeInteger(version)||version<1||!Number.isSafeInteger(rows)||rows<0)throw changed();return{name,version,rows,schemaSha256};
}
async function readAll(table:Table,expected:SnapshotTable,checkpoint:()=>Promise<void>){
    let offset=0;
    while(offset<expected.rows){await checkpoint();const page=await table.query().offset(offset).limit(Math.min(500,expected.rows-offset)).toArrow();
        if(page.numRows<1||page.numRows>expected.rows-offset)throw changed();
        for(const row of page.toArray())for(const field of page.schema.fields)void row[field.name];offset+=page.numRows;
    }
    await checkpoint();for(const index of await table.listIndices()){await checkpoint();await table.indexStats(index.name);}
}

/** All tables keep one checkout; schema, every column, indices and fresh SDK heads are verified. */
export async function openFullSdkSnapshot(store:string,checkpoint:()=>Promise<void>){
    await assertSdkVersion();const physical=await physicalSnapshotTableNames(store),assertNamespace=await assertFlatNamespace(store,snapshotConnect,checkpoint);const owned=await readOnlyConnection(store,physical),database=owned.database,opened:Array<{value:SnapshotTable;table:Table}>=[];let closed=false;
    const close=async()=>{if(closed)return;closed=true;try{for(const value of opened)value.table.close();}finally{await owned.close();}};
    try{
        const names=await allSnapshotTableNames(database,checkpoint);if(snapshotCanonicalJson(names)!==snapshotCanonicalJson(physical))throw changed();
        for(const name of names){await checkpoint();const table=await database.openTable(name);try{const version=await table.version();await table.checkout(version);const value=await metadata(name,table);if(value.version!==version)throw changed();opened.push({value,table});}catch(error){table.close();throw error;}}
        const tables=opened.map(value=>value.value);
        return {names,tables,close,async validateRows(){for(const {table,value} of opened)await readAll(table,value,checkpoint);},async assertCurrent(){
            await assertNamespace();if(snapshotCanonicalJson(await physicalSnapshotTableNames(store))!==snapshotCanonicalJson(physical))throw changed();const fresh=await readOnlyConnection(store,physical),current=fresh.database;
            try{if(snapshotCanonicalJson(await allSnapshotTableNames(current,checkpoint))!==snapshotCanonicalJson(names))throw changed();
                for(const expected of tables){await checkpoint();const table=await current.openTable(expected.name);
                    try{const latest=await table.version();if(latest!==expected.version)throw changed();await table.checkout(latest);
                        if(snapshotCanonicalJson(await metadata(expected.name,table))!==snapshotCanonicalJson(expected))throw changed();for(const index of await table.listIndices())await table.indexStats(index.name);
                    }finally{table.close();}}
            }finally{await fresh.close();}await assertNamespace();
        }};
    }catch(error){await close();throw error;}
}
