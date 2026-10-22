import {test,mock} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {fileURLToPath} from 'node:url';
import {syncBuiltinESMExports} from 'node:module';
import dns from 'node:dns';
import https from 'node:https';
import os from 'node:os';
import {externalBackupConfiguration,createExternalS3Store,retryExternalOperation} from '../production/external-backup.mjs';

const environment={EXTERNAL_BACKUP_S3_ENDPOINT:'https://backup.example.test',EXTERNAL_BACKUP_S3_BUCKET:'private-backup',
    EXTERNAL_BACKUP_S3_REGION:'test-region-1',EXTERNAL_BACKUP_S3_STORAGE_ID:'owned-test',EXTERNAL_BACKUP_S3_INDEPENDENT:'true',
    EXTERNAL_BACKUP_S3_ACCESS_KEY_ID:'synthetic-access',EXTERNAL_BACKUP_S3_SECRET_ACCESS_KEY:'secret-sentinel-never-echo',
    EXTERNAL_BACKUP_S3_SESSION_TOKEN:'session-sentinel-never-echo'};
const config=externalBackupConfiguration(environment),script=fileURLToPath(new URL('../production/external-backup.mjs',import.meta.url));
const flush=()=>new Promise(resolve=>setImmediate(resolve));

/** Resolve through the production lookup callback, with every socket and DNS call owned by this test. */
async function transport(action,{addresses=[{address:'203.0.113.18',family:4}],dnsError,all=false,scenarios=[{}]}={}){
    const requests=[],lookups=[],responses=[];
    const localMock=mock.method(os,'networkInterfaces',()=>({owned:[{address:'192.0.2.24',family:'IPv4'}]}));
    syncBuiltinESMExports();
    const dnsMock=mock.method(dns,'lookup',(host,options,callback)=>{
        lookups.push({host,options});queueMicrotask(()=>callback(dnsError,addresses));
    });
    const requestMock=mock.method(https,'request',(url,options,callback)=>{
        assert.equal(url.origin,config.endpoint);assert.equal(options.rejectUnauthorized,true);assert.equal(options.agent,false);
        assert.equal(typeof options.lookup,'function');assert.match(options.headers.authorization,/^AWS4-HMAC-SHA256 /);
        const request=new EventEmitter(),scenario=scenarios[Math.min(requests.length,scenarios.length-1)];let closed=false;
        const close=()=>{if(!closed){closed=true;request.emit('close');}};
        request.setTimeout=(ms,fn)=>{assert.equal(ms,30000);request.idle=fn;return request;};
        request.destroy=error=>{request.destroyedError=error;queueMicrotask(()=>{request.emit('error',error);close();});return request;};
        request.end=()=>queueMicrotask(()=>options.lookup(url.hostname,{all},(error,...resolved)=>{
            request.resolved=resolved;
            if(error){request.destroy(error);return;}
            if(scenario.error){request.destroy(scenario.error);return;}
            if(scenario.hang)return;
            const response=new PassThrough();responses.push(response);response.statusCode=scenario.status??200;
            response.once('close',close);callback(response);
            if(scenario.aborted){response.emit('aborted');response.destroy();}
            else response.end(scenario.body??Buffer.from('verified bytes'));
        }));
        requests.push(request);return request;
    });
    try{return await action({store:createExternalS3Store(config),requests,lookups});}
    finally{
        for(const response of responses)response.destroy();
        for(const request of requests)request.emit('close');
        requestMock.mock.restore();dnsMock.mock.restore();localMock.mock.restore();syncBuiltinESMExports();
    }
}

for(const [label,args,message] of [
    ['missing command',[],/Команды:/],
    ['unknown command',['unknown'],/Команды:/],
    ['unknown option',['upload','--secret','argv-sentinel-never-echo'],/параметр/],
    ['duplicate option',['upload','--source','first','--source','argv-sentinel-never-echo'],/параметр/],
    ['missing option value',['upload','--source'],/параметр/],
    ['next option used as value',['upload','--source','--backup-id'],/параметр/],
    ['missing upload identifiers',['upload'],/backup ID/],
    ['invalid download identifier',['download','--backup-id','unsafe/id','--expect-sha256','a'.repeat(64),'--destination','unused'],/backup ID/],
]) test(`CLI rejects ${label} without exposing arguments or credentials`,()=>{
    const result=spawnSync(process.execPath,[script,...args],{env:{...process.env,...environment},encoding:'utf8',timeout:2000,maxBuffer:65536});
    assert.ifError(result.error);assert.equal(result.status,1);assert.equal(result.signal,null);assert.equal(result.stdout,'');
    assert.match(result.stderr,message);
    for(const value of ['argv-sentinel-never-echo',environment.EXTERNAL_BACKUP_S3_SECRET_ACCESS_KEY,environment.EXTERNAL_BACKUP_S3_SESSION_TOKEN])assert.ok(!result.stderr.includes(value));
});

for(const key of ['ENDPOINT','BUCKET','REGION'])test(`Configuration rejects a missing required ${key}`,()=>{
    const values={...environment};delete values['EXTERNAL_BACKUP_S3_'+key];assert.throws(()=>externalBackupConfiguration(values),/Нужен/);
});

for(const bucket of ['ab','x'.repeat(64),'has..dots','192.168.1.1','bad_name'])test(`Configuration rejects invalid bucket ${bucket}`,()=>{
    assert.throws(()=>externalBackupConfiguration({...environment,EXTERNAL_BACKUP_S3_BUCKET:bucket}),/bucket, region/);
});

for(const [key,value] of [['REGION','UPPER'],['REGION','x'.repeat(65)],['STORAGE_ID','invalid/path'],['STORAGE_ID','x'.repeat(129)],['SESSION_TOKEN','private\nvalue'],['ACCESS_KEY_ID',42]])test(`Configuration rejects invalid ${key} without disclosing its value`,()=>{
    assert.throws(()=>externalBackupConfiguration({...environment,['EXTERNAL_BACKUP_S3_'+key]:value}),error=>{
        assert.ok(!error.message.includes(String(value)));return true;
    });
});

for(const endpoint of ['https://storage.internal','https://singlelabel','https://storage.example.test#private','https://storage.example.test/\u0001'])test('Configuration rejects non-external or malformed endpoints without echoing them',()=>{
    assert.throws(()=>externalBackupConfiguration({...environment,EXTERNAL_BACKUP_S3_ENDPOINT:endpoint}));
});

test('Configuration freezes a valid session credential configuration',()=>{
    const value=externalBackupConfiguration(environment);assert.equal(Object.isFrozen(value),true);
    assert.equal(value.sessionToken,environment.EXTERNAL_BACKUP_S3_SESSION_TOKEN);assert.equal(value.storageId,'owned-test');
});

for(const address of ['127.0.0.2','0.0.0.0','169.254.1.2','224.0.0.1','255.255.255.255','::','::1','fe80::1','ff02::1','::ffff:127.0.0.2','192.0.2.24'])test(`Resolved blocked address ${address} is rejected before a response is read`,async()=>transport(async({store,requests})=>{
    await assert.rejects(store.get('object',64),/адрес этой машины|локальной службы/);assert.equal(requests.length,1);
},{addresses:[{address,family:address.includes(':')?6:4}]}));

test('A mixed DNS answer containing one local address fails closed',async()=>transport(async({store})=>{
    await assert.rejects(store.get('object',64),/локальной службы/);
},{addresses:[{address:'203.0.113.18',family:4},{address:'127.0.0.1',family:4}]}));

test('An empty DNS answer fails closed without opening another request',async()=>transport(async({store,requests})=>{
    await assert.rejects(store.get('object',64),/локальной службы/);assert.equal(requests.length,1);
},{addresses:[]}));

test('A terminal DNS failure preserves the error without retries',async()=>transport(async({store,requests})=>{
    await assert.rejects(store.get('object',64),{code:'ENOTFOUND'});assert.equal(requests.length,1);
},{dnsError:Object.assign(new Error('owned synthetic DNS failure'),{code:'ENOTFOUND'})}));

for(const all of [false,true])test(`A controlled external DNS answer uses the ${all?'all-address':'single-address'} callback contract`,async()=>transport(async({store,requests,lookups})=>{
    assert.equal((await store.get('object',64)).toString(),'verified bytes');
    assert.deepEqual(lookups,[{host:'backup.example.test',options:{all:true}}]);
    assert.deepEqual(requests[0].resolved,all?[[{address:'203.0.113.18',family:4}]]:['203.0.113.18',4]);
},{all}));

test('An oversized successful response is destroyed and never retried',async()=>transport(async({store,requests})=>{
    await assert.rejects(store.get('object',4),/превышает допустимый размер/);assert.equal(requests.length,1);
},{scenarios:[{body:Buffer.from('12345')}]}));

test('A terminal TLS socket error never gets retried',async()=>transport(async({store,requests})=>{
    await assert.rejects(store.get('object',64),{code:'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'});assert.equal(requests.length,1);
},{scenarios:[{error:Object.assign(new Error('synthetic TLS error'),{code:'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'})}]}));

for(const status of [400,403,404])test(`Terminal HTTP${status} rejects a PUT immediately`,async()=>transport(async({store,requests})=>{
    await assert.rejects(store.put('object',Buffer.from('bytes')),new RegExp('HTTP '+status));assert.equal(requests.length,1);
},{scenarios:[{status}]}));

test('An aborted body is retried once and returns only the next complete response',async t=>{
    t.mock.timers.enable({apis:['setTimeout']});
    await transport(async({store,requests})=>{
        const operation=store.get('object',64);await flush();t.mock.timers.tick(250);
        assert.equal((await operation).toString(),'after abort');assert.equal(requests.length,2);
    },{scenarios:[{aborted:true},{body:Buffer.from('after abort')}]});
});

for(const kind of ['absolute','idle'])test(`The ${kind} request deadline destroys its socket before a bounded retry`,async t=>{
    t.mock.timers.enable({apis:['setTimeout']});
    await transport(async({store,requests})=>{
        const operation=store.get('object',64),rejected=assert.rejects(operation,/HTTP 403/);await flush();
        if(kind==='absolute')t.mock.timers.tick(120000);else requests[0].idle();
        await flush();assert.equal(requests[0].destroyedError.code,'ETIMEDOUT');t.mock.timers.tick(250);
        await rejected;assert.equal(requests.length,2);
    },{scenarios:[{hang:true},{status:403}]});
});

test('Retry exhaustion retains the terminal error and the bounded exponential schedule',async()=>{
    const terminal=Object.assign(new Error('owned temporary failure'),{status:429}),waits=[];let calls=0;
    await assert.rejects(retryExternalOperation(async()=>{calls++;throw terminal;},{wait:async ms=>waits.push(ms)}),error=>error===terminal);
    assert.equal(calls,4);assert.deepEqual(waits,[250,500,1000]);
});
