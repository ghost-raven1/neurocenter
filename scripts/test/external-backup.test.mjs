import {test,mock} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,readdir,stat,open,chmod} from 'node:fs/promises';
import {constants} from 'node:fs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash,generateKeyPairSync} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import https from 'node:https';
import {applicationServices} from '../production/compose-client.mjs';
import {volumeKeys} from '../production/recovery-files.mjs';
import {writeManifest,verifyBackup} from '../production/recovery-manifest.mjs';
import {externalBackupConfiguration,signedS3Request,retryExternalOperation,createExternalS3Store,uploadExternalBackup,downloadExternalBackup,EXTERNAL_CHUNK_BYTES} from '../production/external-backup.mjs';
import {snapshotObjectFile} from '../production/snapshot-recovery-metadata.mjs';
import {chatObjectKey,chatObjectFile} from '../production/chat-recovery-metadata.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
const env={EXTERNAL_BACKUP_S3_ENDPOINT:'https://objects.example.test',EXTERNAL_BACKUP_S3_REGION:'eu-test-1',EXTERNAL_BACKUP_S3_BUCKET:'recovery-test',
    EXTERNAL_BACKUP_S3_ACCESS_KEY_ID:'fixture-access',EXTERNAL_BACKUP_S3_SECRET_ACCESS_KEY:'fixture-secret',EXTERNAL_BACKUP_S3_INDEPENDENT:'true',EXTERNAL_BACKUP_S3_STORAGE_ID:'independent-fixture'};
const config=externalBackupConfiguration(env),backupId='fixture-20261018';
const manifestKey='neurocenter-external-v1/'+backupId+'/manifest.json';

function memoryStore(){
    const objects=new Map(),puts=[],gets=[];
    return {objects,puts,gets,async assertPrivate(){},async put(key,bytes){puts.push(key);if(!objects.has(key)){objects.set(key,Buffer.from(bytes));}},
        async get(key,limit){gets.push(key);if(!objects.has(key)){throw Object.assign(new Error('Отсутствует объект'),{status:404});}const bytes=objects.get(key);if(bytes.length>limit){throw new Error('Превышен размер ответа');}return Buffer.from(bytes);}};
}
async function fixture(action,{large=false,snapshots=false,chat=false}={}){
    const root=await mkdtemp(path.join(tmpdir(),'nc-external-backup-'));const source=path.join(root,'source');await mkdir(source,{mode:0o700});
    try{
        await mkdir(path.join(source,'databases'));for(const name of ['catalog','rag']){await writeFile(path.join(source,'databases',name+'.dump'),'PGDMP fixture '+name);}
        for(const key of volumeKeys){await mkdir(path.join(source,'files',key),{recursive:true});}
        await writeFile(path.join(source,'files/projects/config.json'),'{"settings":"сохраняем параметры"}');
        await writeFile(path.join(source,'files/skills/пустой.md'),'');
        await writeFile(path.join(source,'files/skills/инструкция.md'),'# Проверенные знания');
        if(large){await writeFile(path.join(source,'files/projects/large.bin'),Buffer.alloc(EXTERNAL_CHUNK_BYTES+17,37));}
        let snapshotObjects;
        if(snapshots){const bytes=Buffer.from('exact snapshot object bytes'),sha256=sha(bytes),file=snapshotObjectFile('project-fixture',sha256);await mkdir(path.dirname(path.join(source,file)),{recursive:true,mode:0o700});await writeFile(path.join(source,file),bytes,{mode:0o600});await mkdir(path.join(source,'operatorsecrets'),{mode:0o700});await writeFile(path.join(source,'operatorsecrets/snapshot_signing_key'),generateKeyPairSync('ed25519').privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});snapshotObjects={schemaVersion:1,blobs:[{projectId:'project-fixture',sha256,bytes:bytes.length,storageId:'s3:'+'b'.repeat(32),versionId:'exact-version-1',file}],keyFiles:['operatorsecrets/snapshot_signing_key']};}
        let chatObjects;if(chat){const sourceIdentity={storageId:'d'.repeat(64),projectBucket:'chat-project-source',personalBucket:'chat-personal-source'},bytes=Buffer.from('private original chat bytes');chatObjects={schemaVersion:1,source:sourceIdentity,objects:[],discardedObjects:[],transfers:[]};await mkdir(path.join(source,'chat-objects'),{mode:0o700});for(let index=0;index<2;index++){const id='12345678-1234-4234-8234-00000000000'+(index+1),conversationId='12345678-1234-4234-8234-000000000004',ownerEmail='owner@test',projectId=index?null:'project-fixture',file=chatObjectFile(id);await writeFile(path.join(source,file),bytes,{mode:0o600});chatObjects.objects.push({id,storageId:sourceIdentity.storageId,bucket:index?sourceIdentity.personalBucket:sourceIdentity.projectBucket,objectKey:chatObjectKey(projectId,ownerEmail,conversationId,id),versionId:index?null:'old-version',sha256:sha(bytes),bytes:bytes.length,state:'LIVE',attachmentId:'12345678-1234-4234-8234-00000000000'+(index+5),conversationId,ownerEmail,projectId,file});}}
        const image='sha256:'+'a'.repeat(64);const {manifest,sha256}=await writeManifest(source,{createdAt:'2026-10-18T00:00:00Z',postgresMajor:16,postgresImage:image,
            images:Object.fromEntries(applicationServices.map(service=>[service,image])),quiesced:true,
            databases:['catalog','rag'].map(name=>({name,owner:name==='catalog'?'nc_catalog':'nc_rag',encoding:'UTF8',collate:'C.UTF-8',ctype:'C.UTF-8',file:'databases/'+name+'.dump'})),...(snapshotObjects?{snapshotObjects}:{}),...(chatObjects?{chatObjects}:{})});
        const store=memoryStore();const values={source,expectedHash:sha256,backupId,config,store};await action({root,source,manifest,sha256,store,values});
    }finally{await rm(root,{recursive:true,force:true});}
}

test('Конфигурация требует независимость, HTTPS, DNS-имя и закрытые реквизиты',()=>{
    assert.equal(config.endpoint,'https://objects.example.test');
    for(const endpoint of ['http://objects.example.test','file:///copy','https://localhost','https://x.localhost','https://storage.local','https://127.0.0.1','https://[::1]','https://user:secret@objects.example.test','https://objects.example.test/path','https://objects.example.test?token=x']){
        assert.throws(()=>externalBackupConfiguration({...env,EXTERNAL_BACKUP_S3_ENDPOINT:endpoint}));
    }
    for(const key of ['INDEPENDENT','ACCESS_KEY_ID','SECRET_ACCESS_KEY','STORAGE_ID']){
        assert.throws(()=>externalBackupConfiguration({...env,['EXTERNAL_BACKUP_S3_'+key]:''}));
    }
    assert.throws(()=>externalBackupConfiguration({...env,EXTERNAL_BACKUP_S3_INDEPENDENT:'false'}));
});

test('SigV4 подписывает SHA тела, условную запись и безопасный путь без реквизитов в URL',()=>{
    const body=Buffer.from('данные'),request=signedS3Request({...config,sessionToken:'fixture-session'},'PUT','copy/русский файл!*',body,new Date('2026-10-18T12:34:56Z'));
    assert.equal(request.url.pathname,'/recovery-test/copy/%D1%80%D1%83%D1%81%D1%81%D0%BA%D0%B8%D0%B9%20%D1%84%D0%B0%D0%B9%D0%BB%21%2A');
    assert.equal(request.headers['x-amz-content-sha256'],sha(body));assert.equal(request.headers['x-amz-date'],'20261018T123456Z');
    assert.equal(request.headers['if-none-match'],'*');assert.ok(request.headers.authorization.includes('if-none-match;x-amz-content-sha256;x-amz-date;x-amz-security-token'));
    assert.match(request.headers.authorization,/Signature=[a-f0-9]{64}$/);assert.ok(!request.url.href.includes('fixture-secret'));
    assert.notEqual(request.headers.authorization,signedS3Request({...config,sessionToken:'fixture-session'},'PUT','copy/русский файл!*',Buffer.from('другие данные'),new Date('2026-10-18T12:34:56Z')).headers.authorization);
});

test('Bucket control queries are included in the actual SigV4 canonical request',()=>{
    const at=new Date('2026-10-22T00:00:00Z');
    const acl=signedS3Request(config,'GET','',undefined,at,'acl'),policy=signedS3Request(config,'GET','',undefined,at,'policy');
    assert.equal(acl.url.search,'?acl=');assert.equal(policy.url.search,'?policy=');
    assert.notEqual(acl.headers.authorization,policy.headers.authorization);
    assert.notEqual(acl.headers.authorization,signedS3Request(config,'GET','',undefined,at).headers.authorization);
    assert.throws(()=>signedS3Request(config,'GET','',undefined,at,'unknown'));
});

test('Signed privacy adapter accepts only a bounded explicit missing-policy response and a private ACL',async()=>{
    const acl='<AccessControlPolicy><Owner><ID>ceph-owner</ID></Owner><AccessControlList><Grant><Grantee xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="CanonicalUser"><ID>ceph-owner</ID></Grantee><Permission>FULL_CONTROL</Permission></Grant></AccessControlList></AccessControlPolicy>';
    for(const missing of ['NoSuchBucketPolicy','NoSuchPolicy','NoSuchBucket','AccessDenied','oversized','403-code','wrong-root','duplicate-code','200-code']){
        const calls=[];
        const requestMock=mock.method(https,'request',(url,options,callback)=>{
            calls.push(url.search);assert.equal(options.rejectUnauthorized,true);assert.ok(options.headers.authorization.startsWith('AWS4-HMAC-SHA256'));
            const request=new EventEmitter();request.setTimeout=()=>request;request.destroy=error=>request.emit('error',error);
            request.end=()=>queueMicrotask(()=>{
                const response=new PassThrough(),policy=url.search==='?policy=';response.statusCode=policy?(missing==='403-code'?403:missing==='200-code'?200:404):200;
                const body=missing==='oversized'?'x'.repeat(65537):missing==='wrong-root'?'<Unexpected><Code>NoSuchPolicy</Code></Unexpected>'
                    :missing==='duplicate-code'?'<Error><Code>NoSuchPolicy</Code><Code>AccessDenied</Code></Error>'
                    :'<Error><Code>'+(['403-code','200-code'].includes(missing)?'NoSuchPolicy':missing)+'</Code></Error>';
                callback(response);response.end(policy?body:acl);
                queueMicrotask(()=>request.emit('close'));
            });
            return request;
        });
        try{
            if(['NoSuchBucketPolicy','NoSuchPolicy'].includes(missing)){
                await createExternalS3Store(config).assertPrivate();assert.deepEqual(calls,['?policy=','?acl=']);
            }else{
                await assert.rejects(createExternalS3Store(config).assertPrivate(),/S3_BUCKET_PRIVACY_UNCONFIRMED/);assert.deepEqual(calls,['?policy=']);
            }
        }finally{requestMock.mock.restore();}
    }
});

test('Временный сбой повторяется ограниченно; TLS и 403 сразу останавливают операцию',async()=>{
    const waits=[];let attempts=0;
    assert.equal(await retryExternalOperation(async()=>{attempts++;if(attempts<3){throw Object.assign(new Error('temporary'),{status:503});}return 'ok';},{wait:async ms=>waits.push(ms)}),'ok');
    assert.equal(attempts,3);assert.deepEqual(waits,[250,500]);
    attempts=0;await assert.rejects(retryExternalOperation(async()=>{attempts++;throw Object.assign(new Error('temporary'),{code:'ECONNRESET'});},{wait:async()=>{}}));assert.equal(attempts,4);
    for(const error of [Object.assign(new Error('TLS'),{code:'CERT_HAS_EXPIRED'}),Object.assign(new Error('Forbidden'),{status:403})]){
        attempts=0;await assert.rejects(retryExternalOperation(async()=>{attempts++;throw error;},{wait:async()=>{}}));assert.equal(attempts,1);
    }
});

test('HTTP redirect не выполняется, TLS-проверка остаётся включённой',async()=>{
    let calls=0;
    const requestMock=mock.method(https,'request',(url,options,callback)=>{
        calls++;assert.equal(url.protocol,'https:');assert.equal(options.rejectUnauthorized,true);assert.equal(options.agent,false);assert.equal(typeof options.lookup,'function');
        const request=new EventEmitter();request.setTimeout=()=>request;request.destroy=error=>request.emit('error',error);
        request.end=()=>queueMicrotask(()=>{const response=new PassThrough();response.statusCode=302;response.headers={location:'http://attacker.test'};callback(response);response.end('redirect');queueMicrotask(()=>request.emit('close'));});
        return request;
    });
    try{await assert.rejects(createExternalS3Store(config).get('object',1024),/HTTP 302/);assert.equal(calls,1);}
    finally{requestMock.mock.restore();}
});

test('External privacy gate rejects a public backup destination before the first PUT',async()=>fixture(async({store,values})=>{
    store.assertPrivate=async()=>{throw new Error('private-bucket-required');};
    await assert.rejects(uploadExternalBackup(values),/private-bucket-required/);
    assert.equal(store.puts.length,0);assert.equal(store.objects.size,0);
}));

test('Missing privacy attestation rejects an unverified custom backup transport',async()=>fixture(async({store,values})=>{
    delete store.assertPrivate;
    await assert.rejects(uploadExternalBackup(values),/приватност/);
    assert.equal(store.puts.length,0);
}));

test('Policy drift blocks later PUTs and manifest publication',async()=>fixture(async({store,values})=>{
    store.assertPrivate=async()=>{if(store.puts.length)throw new Error('private-bucket-changed');};
    await assert.rejects(uploadExternalBackup(values),/private-bucket-changed/);
    assert.equal(store.puts.length,1);assert.ok(!store.objects.has(manifestKey));
}));

test('External download privacy gate rejects before reading a manifest or creating staging',async()=>fixture(async({root,store,values})=>{
    await uploadExternalBackup(values);store.gets.length=0;
    store.assertPrivate=async()=>{throw new Error('private-bucket-required');};
    const destination=path.join(root,'private-download');
    await assert.rejects(downloadExternalBackup({...values,destination}),/private-bucket-required/);
    assert.equal(store.gets.length,0);assert.ok(!(await readdir(root)).includes('private-download'));
    assert.ok(!(await readdir(root)).some(name=>name.startsWith('.neurocenter-external-')));
}));

test('Полный recovery-v4 комплект проходит внешний readback и восстанавливается в новый каталог',async()=>fixture(async({root,manifest,sha256,store,values})=>{
    const receipt=await uploadExternalBackup(values);
    assert.equal(receipt.verification,'sha256-readback');assert.equal(receipt.independence,'operator-declared');assert.equal(receipt.crossHostRestoreVerified,false);
    assert.equal(receipt.files,manifest.entries.filter(entry=>entry.type==='file').length);assert.equal(store.puts.at(-1),manifestKey);
    for(const key of store.objects.keys()){assert.ok(store.gets.includes(key));}
    assert.ok(!JSON.stringify(receipt).includes('fixture-secret'));
    const destination=path.join(root,'download');const downloaded=await downloadExternalBackup({...values,destination});
    assert.equal(downloaded.crossHostRestoreVerified,false);assert.deepEqual(await verifyBackup(destination,sha256),manifest);
    assert.equal(await readFile(path.join(destination,'files/projects/config.json'),'utf8'),'{"settings":"сохраняем параметры"}');
    assert.equal((await stat(destination)).mode&0o777,0o700);
}));
test('External v4 roundtrip retains exact S3 object files and private signer bytes/modes',async()=>fixture(async({root,source,manifest,values})=>{
    await uploadExternalBackup(values);const destination=path.join(root,'download');await downloadExternalBackup({...values,destination});
    for(const file of [manifest.snapshotObjects.blobs[0].file,...manifest.snapshotObjects.keyFiles]){assert.deepEqual(await readFile(path.join(destination,file)),await readFile(path.join(source,file)));assert.equal((await stat(path.join(destination,file))).mode&0o777,0o600);}
    assert.equal((await stat(path.join(destination,'operatorsecrets'))).mode&0o777,0o700);
},{snapshots:true}));

test('External v4 roundtrip preserves both private chat originals, exact versions, hashes and ownership metadata',async()=>fixture(async({root,source,manifest,sha256,values})=>{
    assert.equal(manifest.format,'neurocenter-recovery-v4');await uploadExternalBackup(values);const destination=path.join(root,'chat-download');await downloadExternalBackup({...values,destination});const actual=await verifyBackup(destination,sha256);assert.deepEqual(actual.chatObjects,manifest.chatObjects);assert.deepEqual(actual.chatObjects.objects.map(row=>row.versionId),['old-version',null]);for(const row of actual.chatObjects.objects){assert.deepEqual(await readFile(path.join(destination,row.file)),await readFile(path.join(source,row.file)));assert.equal((await stat(path.join(destination,row.file))).mode&0o777,0o600);}assert.equal((await stat(path.join(destination,'chat-objects'))).mode&0o777,0o700);
},{chat:true}));

test('Trusted legacy v2/v3 bundles without chat refs retain actual upload/download compatibility',async()=>{
 for(const format of ['neurocenter-recovery-v2','neurocenter-recovery-v3'])await fixture(async({root,source,manifest,values})=>{const historical={...manifest,format};delete historical.chatObjects;const raw=JSON.stringify(historical)+'\n';await writeFile(path.join(source,'manifest.json'),raw,{mode:0o600});const expectedHash=sha(raw),input={...values,expectedHash};await uploadExternalBackup(input);const destination=path.join(root,'legacy-download');await downloadExternalBackup({...input,destination});assert.equal((await verifyBackup(destination,expectedHash)).format,format);});
});

test('Файл больше блока передаётся несколькими объектами и собирается без потери байтов',async()=>fixture(async({root,sha256,store,values})=>{
    await uploadExternalBackup(values);assert.equal([...store.objects.keys()].filter(key=>key.includes('/'+sha('files/projects/large.bin')+'/')).length,2);
    const destination=path.join(root,'download');await downloadExternalBackup({...values,destination});await verifyBackup(destination,sha256);
    assert.equal((await stat(path.join(destination,'files/projects/large.bin'))).size,EXTERNAL_CHUNK_BYTES+17);
},{large:true}));

test('Повтор после обрыва переиспользует неизменяемые объекты и сверяет их байты',async()=>fixture(async({store,values})=>{
    const get=store.get.bind(store);let failed=false;
    store.get=async(key,limit)=>{if(!failed){failed=true;throw new Error('обрыв');}return get(key,limit);};
    await assert.rejects(uploadExternalBackup(values),/обрыв/);assert.ok(!store.objects.has(manifestKey));assert.ok(store.objects.size>0);
    const before=new Map(store.objects);const receipt=await uploadExternalBackup(values);assert.equal(receipt.ok,true);
    for(const [key,value] of before){assert.deepEqual(store.objects.get(key),value);}
}));

test('Локальная порча обнаруживается до первого внешнего PUT',async()=>fixture(async({source,store,values})=>{
    await writeFile(path.join(source,'databases/catalog.dump'),'повреждение');await assert.rejects(uploadExternalBackup(values));assert.equal(store.puts.length,0);
}));

test('Корректные S3-метаданные не заменяют SHA чтения: повреждённый объект не получает опись',async()=>fixture(async({store,values})=>{
    const get=store.get.bind(store);store.get=async(key,limit)=>{const bytes=await get(key,limit);if(bytes.length){bytes[0]^=1;}return bytes;};
    await assert.rejects(uploadExternalBackup(values),/SHA256/);assert.ok(!store.objects.has(manifestKey));
}));

test('Изменение локального дерева во время передачи не публикует готовый комплект',async()=>fixture(async({source,store,values})=>{
    const get=store.get.bind(store);let changed=false;store.get=async(key,limit)=>{if(!changed){changed=true;await writeFile(path.join(source,'files/projects/extra'),'новый файл');}return get(key,limit);};
    await assert.rejects(uploadExternalBackup(values));assert.ok(!store.objects.has(manifestKey));
}));

test('Существующий destination не трогается и не запускает сетевых чтений',async()=>fixture(async({root,store,values})=>{
    const destination=path.join(root,'existing');await mkdir(destination);await writeFile(path.join(destination,'keep'),'сохранить');
    await assert.rejects(downloadExternalBackup({...values,destination}),/уже существует/);assert.equal(store.gets.length,0);assert.equal(await readFile(path.join(destination,'keep'),'utf8'),'сохранить');
}));

test('Подменённая внешняя опись блокирует создание каталога',async()=>fixture(async({root,store,values})=>{
    store.objects.set(manifestKey,Buffer.from('{}'));const destination=path.join(root,'download');
    await assert.rejects(downloadExternalBackup({...values,destination}),/SHA256/);await assert.rejects(stat(destination),{code:'ENOENT'});
}));

test('Traversal в описи отклоняется даже при совпадающей внешней квитанции',async()=>fixture(async({root,manifest,store,values})=>{
    const changed=structuredClone(manifest);changed.entries[0].path='../escape';const raw=Buffer.from(JSON.stringify(changed));store.objects.set(manifestKey,raw);
    const destination=path.join(root,'download');await assert.rejects(downloadExternalBackup({...values,expectedHash:sha(raw),destination}));await assert.rejects(stat(destination),{code:'ENOENT'});await assert.rejects(stat(path.join(root,'escape')),{code:'ENOENT'});
}));

test('Повреждение скачанного блока очищает staging и не публикует destination',async()=>fixture(async({root,store,values})=>{
    await uploadExternalBackup(values);const key=[...store.objects.keys()].find(key=>key.includes('/'+sha('databases/catalog.dump')+'/'));store.objects.get(key)[0]^=1;
    const destination=path.join(root,'download');await assert.rejects(downloadExternalBackup({...values,destination}),/SHA256/);await assert.rejects(stat(destination),{code:'ENOENT'});
    assert.deepEqual((await readdir(root)).filter(name=>name.startsWith('.neurocenter-external-')),[]);
}));

test('Небезопасные backup ID и отсутствие SHA не читают исходные данные',async()=>fixture(async({store,values})=>{
    for(const backupId of ['../copy','a/b','','x?secret']){await assert.rejects(uploadExternalBackup({...values,backupId}));}
    await assert.rejects(uploadExternalBackup({...values,expectedHash:undefined}));assert.equal(store.puts.length,0);
}));

test('DNS loopback и адрес текущей машины отклоняются до отправки данных',async()=>{
    const {default:dns}=await import('node:dns');const {networkInterfaces}=await import('node:os');
    const own=Object.values(networkInterfaces()).flat().find(item=>item&&!item.internal)?.address;
    for(const address of ['127.0.0.2','169.254.1.2','::1',...(own?[own]:[])]){
        const dnsMock=mock.method(dns,'lookup',(host,options,callback)=>callback(null,[{address,family:address.includes(':')?6:4}]));
        const requestMock=mock.method(https,'request',(url,options)=>{
            const request=new EventEmitter();request.setTimeout=()=>request;request.destroy=error=>request.emit('error',error);
            request.end=()=>queueMicrotask(()=>options.lookup(url.hostname,{all:true},error=>{assert.ok(error);request.emit('error',error);request.emit('close');}));
            return request;
        });
        try{await assert.rejects(createExternalS3Store(config).get('object',1024),/адрес этой машины|локальной службы/);}
        finally{requestMock.mock.restore();dnsMock.mock.restore();}
    }
});

test('Условный PUT принимает 412 для последующей сверки байтов и не поглощает 403',async()=>{
    for(const status of [412,403]){
        const requestMock=mock.method(https,'request',(url,options,callback)=>{
            assert.equal(options.method,'PUT');assert.equal(options.headers['if-none-match'],'*');
            const request=new EventEmitter();request.setTimeout=()=>request;request.destroy=error=>request.emit('error',error);
            request.end=()=>queueMicrotask(()=>{const response=new PassThrough();response.statusCode=status;callback(response);queueMicrotask(()=>request.emit('close'));});
            return request;
        });
        try{
            const result=createExternalS3Store(config).put('object',Buffer.from('fixture'));
            if(status===412){await result;}else{await assert.rejects(result,/HTTP 403/);}
        }finally{requestMock.mock.restore();}
    }
});


test('Подмена следующего исходного файла FIFO не подвешивает внешнюю копию',{skip:process.platform==='win32'},async()=>fixture(async({source,store,values})=>{
    const put=store.put.bind(store);const fifo=path.join(source,'databases/rag.dump');let changed=false;let timer;
    store.put=async(key,bytes)=>{
        await put(key,bytes);
        if(changed){return;}changed=true;await rm(fifo);await promisify(execFile)('mkfifo',[fifo]);
        // При регрессии разблокируем старый blocking open, чтобы тест завершился с понятным отказом.
        timer=setTimeout(()=>{void open(fifo,constants.O_RDWR|constants.O_NONBLOCK).then(handle=>handle.close()).catch(()=>undefined);},3000);
    };
    const started=Date.now();
    try{await assert.rejects(uploadExternalBackup(values),/Исходный файл изменился/);assert.ok(Date.now()-started<2000,'FIFO должен отклоняться без ожидания писателя');assert.ok(!store.objects.has(manifestKey));}
    finally{clearTimeout(timer);}
}));

test('Скачивание сохраняет исполняемые права и публикует проверяемый комплект',async()=>fixture(async({root,source,manifest,store,values})=>{
    await chmod(path.join(source,'files/projects/config.json'),0o751);
    await rm(path.join(source,'manifest.json'));const {sha256}=await writeManifest(source,manifest);
    const updated={...values,expectedHash:sha256};await uploadExternalBackup(updated);
    const destination=path.join(root,'executable-download');await downloadExternalBackup({...updated,destination});
    await verifyBackup(destination,sha256);assert.equal((await stat(path.join(destination,'files/projects/config.json'))).mode&0o777,0o751);
}));
