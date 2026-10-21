'use strict';
const fs=require('node:fs/promises');
const {constants}=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {createHash}=require('node:crypto');
const {connect}=require('@lancedb/lancedb');
const {normalizeSnapshotManifest,snapshotManifestHash,snapshotCanonicalJson,snapshotSchemaHash}=require('../../services/shared/project-snapshot.cjs');
const sha=value=>createHash('sha256').update(value).digest('hex');

async function inventory(root){
    const files=[];
    async function walk(directory,depth){
        if(depth>64)throw new Error('FILES_CHANGED');
        for(const entry of await fs.readdir(directory,{withFileTypes:true})){
            const file=path.join(directory,entry.name),stat=await fs.lstat(file);
            if(stat.isSymbolicLink()||!stat.isDirectory()&&(!stat.isFile()||stat.nlink!==1))throw new Error('FILES_CHANGED');
            if(stat.isDirectory())await walk(file,depth+1);
            else{
                if(files.length>=50000)throw new Error('FILES_CHANGED');
                const handle=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK),digest=createHash('sha256');let bytes=0;
                try{for await(const chunk of handle.createReadStream({autoClose:false})){bytes+=chunk.length;if(bytes>stat.size)throw new Error('FILES_CHANGED');digest.update(chunk);}const after=await handle.stat();
                    if(bytes!==stat.size||after.ino!==stat.ino||after.mtimeMs!==stat.mtimeMs)throw new Error('FILES_CHANGED');
                }finally{await handle.close();}
                files.push({path:path.relative(root,file).split(path.sep).join('/'),size:bytes,sha256:digest.digest('hex')});
            }
        }
    }
    await walk(root,0);return files.sort((a,b)=>a.path.localeCompare(b.path,'en'));
}
async function verifyImage(root){
    const manifest=normalizeSnapshotManifest(JSON.parse(await fs.readFile(path.join(root,'manifest.json'),'utf8'))),directory=path.join(root,'database');
    const expected=manifest.files.map(({path,size,sha256})=>({path,size,sha256}));
    if(snapshotCanonicalJson(await inventory(directory))!==snapshotCanonicalJson(expected))throw new Error('FILES_CHANGED');
    const scratch=await fs.mkdtemp(path.join(os.tmpdir(),'neurocenter-snapshot-sdk-'));let database;const tables=[];let readRows=0;
    try{
        for(const table of manifest.tables)await fs.symlink(path.join(directory,table.name+'.lance'),path.join(scratch,table.name+'.lance'),'dir');
        database=await connect(scratch,{manifestEnabled:false});
        const names=[];let startAfter;
        for(;;){const page=await database.tableNames({limit:128,...(startAfter?{startAfter}:{})});if(!page.length)break;
            if(page.some(name=>names.includes(name))||names.length+page.length>512)throw new Error('LANCE_READ_FAILED');names.push(...page);startAfter=page.at(-1);
        }names.sort();
        if(snapshotCanonicalJson(names)!==snapshotCanonicalJson(manifest.tables.map(table=>table.name).sort()))throw new Error('LANCE_READ_FAILED');
        for(const source of manifest.tables){
            const table=await database.openTable(source.name);
            try{
                const version=await table.version();if(version!==source.version)throw new Error('LANCE_READ_FAILED');await table.checkout(version);
                const rows=await table.countRows(),schemaSha256=snapshotSchemaHash(await table.schema());
                if(rows!==source.rows||schemaSha256!==source.schemaSha256)throw new Error('LANCE_READ_FAILED');
                let read=0;
                while(read<rows){const page=await table.query().offset(read).limit(Math.min(500,rows-read)).toArrow();
                    if(page.numRows<1||page.numRows>rows-read)throw new Error('LANCE_READ_FAILED');
                    // Materialize every column so missing/corrupted referenced data cannot pass on metadata alone.
                    for(const row of page.toArray())for(const field of page.schema.fields)void row[field.name];
                    read+=page.numRows;
                }
                for(const index of await table.listIndices())await table.indexStats(index.name);
                readRows+=read;tables.push({name:source.name,version,rows,schemaSha256});
            }finally{table.close();}
        }
    }finally{database?.close();await fs.rm(scratch,{recursive:true,force:true});}
    if(snapshotCanonicalJson(await inventory(directory))!==snapshotCanonicalJson(expected))throw new Error('FILES_CHANGED');
    return {format:'neurocenter.snapshot-verification/v1',manifestSha256:snapshotManifestHash(manifest),sdkVersion:'0.29.0',tables,
        filesSha256:sha(snapshotCanonicalJson(manifest.files)),fileCount:manifest.files.length,bytes:manifest.files.reduce((sum,file)=>sum+file.size,0),readRows};
}
module.exports={verifyImage,inventory};
if(require.main===module)verifyImage('/snapshot').then(value=>process.stdout.write(JSON.stringify(value)+'\n')).catch(error=>{process.stderr.write(['FILES_CHANGED','LANCE_READ_FAILED'].includes(error.message)?error.message+'\n':'LANCE_READ_FAILED\n');process.exitCode=1;});
