'use strict';
const {createHash}=require('node:crypto');
const SNAPSHOT_CHUNK_BYTES=64*1024*1024;
const hash=value=>createHash('sha256').update(value).digest('hex');
const sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const integer=(value,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(value)&&value>=0&&value<=max;
const fail=()=>{throw new Error('Некорректная опись полного снимка LanceDB.');};
function keys(value,names){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==names.length||names.some(key=>!Object.hasOwn(value,key)))fail();}
/** Canonical JSON signs values, never insertion order or an unsigned transport wrapper. */
function snapshotCanonicalJson(value){
    if(Array.isArray(value))return '['+value.map(snapshotCanonicalJson).join(',')+']';
    if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+snapshotCanonicalJson(value[key])).join(',')+'}';
    if(value===undefined||typeof value==='number'&&!Number.isFinite(value))fail();
    return JSON.stringify(value);
}
/** Portable paths have no aliases on Windows, macOS or Linux. */
function snapshotFilePath(value){
    return typeof value==='string'&&value.length<=1024&&value===value.normalize('NFC')&&!/[\\:\x00-\x1f\x7f]/.test(value)
        &&value.split('/').every(part=>part&&part!=='.'&&part!=='..'&&!/[. ]$/.test(part)&&! /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}
function normalizeSnapshotManifest(input){
    keys(input,['format','schemaVersion','sdkVersion','tables','files']);
    if(input.format!=='neurocenter.lancedb-snapshot'||input.schemaVersion!==1||input.sdkVersion!=='0.29.0'
        ||!Array.isArray(input.tables)||!input.tables.length||input.tables.length>512||!Array.isArray(input.files)||!input.files.length||input.files.length>50000)fail();
    const names=new Set();
    const tables=input.tables.map(table=>{
        keys(table,['name','version','rows','schemaSha256']);
        if(typeof table.name!=='string'||!/^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,127}$/.test(table.name)||names.has(table.name.toLowerCase())
            ||!integer(table.version)||table.version<1||!integer(table.rows)||!sha(table.schemaSha256))fail();
        names.add(table.name.toLowerCase());return {...table};
    }).sort((a,b)=>a.name.localeCompare(b.name,'en'));
    const tableNames=new Set(tables.map(table=>table.name));const paths=new Set(),chunkSizes=new Map();let bytes=0,chunks=0;
    const files=input.files.map(file=>{
        keys(file,['path','size','sha256','chunks']);
        if(!snapshotFilePath(file.path)||paths.has(file.path.toLowerCase())||!integer(file.size)||!sha(file.sha256)||!Array.isArray(file.chunks))fail();
        const prefix=file.path.split('/');
        if(prefix.length<2||!prefix[0].endsWith('.lance')||!tableNames.has(prefix[0].slice(0,-6)))fail();
        paths.add(file.path.toLowerCase());let size=0;
        const parts=file.chunks.map((chunk,index)=>{
            keys(chunk,['sha256','size']);
            if(!sha(chunk.sha256)||!integer(chunk.size,SNAPSHOT_CHUNK_BYTES)||chunk.size===0||index<file.chunks.length-1&&chunk.size!==SNAPSHOT_CHUNK_BYTES)fail();
            if(chunkSizes.has(chunk.sha256)&&chunkSizes.get(chunk.sha256)!==chunk.size)fail();chunkSizes.set(chunk.sha256,chunk.size);
            size+=chunk.size;if(++chunks>1000000||!integer(size))fail();return {...chunk};
        });
        bytes+=file.size;if(size!==file.size||!integer(bytes)||file.size===0&&file.sha256!==hash(''))fail();
        return {path:file.path,size:file.size,sha256:file.sha256,chunks:parts};
    }).sort((a,b)=>a.path.localeCompare(b.path,'en'));
    const sortedPaths=[...paths].sort();
    for(let index=1;index<sortedPaths.length;index++)if(sortedPaths[index].startsWith(sortedPaths[index-1]+'/'))fail();
    for(const table of tables)if(!files.some(file=>file.path.startsWith(table.name+'.lance/')))fail();
    return {format:input.format,schemaVersion:1,sdkVersion:input.sdkVersion,tables,files};
}
const snapshotManifestHash=input=>hash(snapshotCanonicalJson(normalizeSnapshotManifest(input)));
/** Arrow schema is compared on both producer and isolated verifier with the pinned SDK. */
const snapshotSchemaHash=schema=>hash(snapshotCanonicalJson(schema.fields.map(field=>({name:field.name,nullable:field.nullable,type:field.type.toString()}))));
module.exports={SNAPSHOT_CHUNK_BYTES,snapshotCanonicalJson,snapshotFilePath,normalizeSnapshotManifest,snapshotManifestHash,snapshotSchemaHash};
