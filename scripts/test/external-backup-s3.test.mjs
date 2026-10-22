import {test,mock} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import {applicationServices} from '../production/compose-client.mjs';
import {volumeKeys} from '../production/recovery-files.mjs';
import {writeManifest,verifyBackup} from '../production/recovery-manifest.mjs';
import {createExternalS3Store,uploadExternalBackup,downloadExternalBackup} from '../production/external-backup.mjs';

const configFile=process.env.EXTERNAL_BACKUP_TEST_S3_CONFIG;
/** Only an explicitly owned local peer is admitted; the live application's S3 port is forbidden. */
async function fixture(action){
    const supplied=JSON.parse(await readFile(configFile,'utf8')),url=new URL(supplied.CHAT_S3_ENDPOINT);
    assert.equal(url.protocol,'http:');assert.equal(url.hostname,'127.0.0.1');assert.ok(url.port&&url.port!=='19010');
    assert.equal(url.pathname,'/');assert.ok(!url.username&&!url.password&&!url.search&&!url.hash);
    const {Client}=createRequire(new URL('../../services/catalog-service/package.json',import.meta.url))('minio');
    const client=new Client({endPoint:url.hostname,port:Number(url.port),useSSL:false,region:supplied.CHAT_S3_REGION,
        accessKey:supplied.CHAT_S3_ACCESS_KEY,secretKey:supplied.CHAT_S3_SECRET_KEY,retryOptions:{disableRetry:true}});
    const bucket='qa-external-'+randomUUID(),root=await mkdtemp(path.join(tmpdir(),'nc-external-s3-'));
    const source=path.join(root,'source');await mkdir(source,{mode:0o700});let created=false;
    // A test-only transport adapter uses the existing HTTP peer. Signing and every S3 response are real.
    const transport=mock.method(https,'request',(target,options,callback)=>{
        assert.equal(target.origin,url.origin);assert.ok(target.pathname.startsWith('/'+bucket+'/'));
        return http.request(target,options,callback);
    });
    try{
        await client.makeBucket(bucket,supplied.CHAT_S3_REGION);created=true;
        await mkdir(path.join(source,'databases'));
        for(const name of ['catalog','rag'])await writeFile(path.join(source,'databases',name+'.dump'),'PGDMP small fixture '+name);
        for(const key of volumeKeys)await mkdir(path.join(source,'files',key),{recursive:true});
        await writeFile(path.join(source,'files/projects/settings.json'),'{"retained":true}');
        const image='sha256:'+'a'.repeat(64),{manifest,sha256}=await writeManifest(source,{createdAt:'2026-10-22T00:00:00Z',postgresMajor:16,postgresImage:image,
            images:Object.fromEntries(applicationServices.map(service=>[service,image])),quiesced:true,
            databases:['catalog','rag'].map(name=>({name,owner:name==='catalog'?'nc_catalog':'nc_rag',encoding:'UTF8',collate:'C.UTF-8',ctype:'C.UTF-8',file:'databases/'+name+'.dump'}))});
        const config={endpoint:url.origin,bucket,region:supplied.CHAT_S3_REGION,accessKeyId:supplied.CHAT_S3_ACCESS_KEY,secretAccessKey:supplied.CHAT_S3_SECRET_KEY,storageId:'owned-qa-only'};
        await action({client,bucket,root,source,manifest,sha256,store:createExternalS3Store(config),values:{source,expectedHash:sha256,backupId:'owned-qa',config}});
    }finally{
        transport.mock.restore();
        if(created){
            for await(const object of client.listObjectsV2(bucket,'',true))await client.removeObject(bucket,object.name);
            await client.removeBucket(bucket);
            assert.equal(await client.bucketExists(bucket),false);
        }
        await rm(root,{recursive:true,force:true});
    }
}

test('Actual signed S3 backup roundtrip verifies private controls, immutable replay and downloaded bytes',{skip:!configFile,timeout:30000},async()=>fixture(async({root,manifest,sha256,store,values})=>{
    assert.equal((await uploadExternalBackup({...values,store})).ok,true);
    assert.equal((await uploadExternalBackup({...values,store})).ok,true);
    const destination=path.join(root,'download');await downloadExternalBackup({...values,store,destination});
    assert.deepEqual(await verifyBackup(destination,sha256),manifest);
    assert.equal(await readFile(path.join(destination,'files/projects/settings.json'),'utf8'),'{"retained":true}');
}));

test('Actual public S3 policy blocks all external backup PUTs',{skip:!configFile,timeout:30000},async()=>fixture(async({client,bucket,store,values})=>{
    await client.setBucketPolicy(bucket,JSON.stringify({Version:'2012-10-17',Statement:[{Effect:'Allow',Principal:'*',Action:['s3:GetObject'],Resource:['arn:aws:s3:::'+bucket+'/*']}]}));
    await assert.rejects(uploadExternalBackup({...values,store}),/S3_BUCKET_PRIVACY_UNCONFIRMED/);
    const objects=[];for await(const object of client.listObjectsV2(bucket,'',true))objects.push(object);
    assert.equal(objects.length,0);
}));
