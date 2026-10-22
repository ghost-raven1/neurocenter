import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const folder=fileURLToPath(new URL('.',import.meta.url));
const entries=[
    ['dev-model-credentials-db','CATALOG_TEST_PG_URL'],
    ['dev-snapshots-db','CATALOG_TEST_PG_URL'],
    ['device-completion-scope-db','DEVICE_QUEUE_TEST_PG_URL'],
    ['device-job-requests-db','DEVICE_REQUEST_TEST_PG_URL'],
    ['device-queue-boundaries-db','DEVICE_QUEUE_TEST_PG_URL'],
    ['device-queue-capacity-db','DEVICE_QUEUE_TEST_PG_URL'],
    ['hosted-rag-grants-db','REMOTE_MODEL_TEST_PG_URL'],
    ['operation-scope-db','OPERATION_TEST_PG_URL'],
    ['production-model-credentials-db','CATALOG_TEST_PG_URL'],
    ['project-assets-db','PUBLICATION_TEST_PG_URL'],
    ['project-retention-db','PROJECT_RETENTION_TEST_PG_URL'],
    ['publication-db','PUBLICATION_TEST_PG_URL'],
    ['publication-scenario-db','PUBLICATION_SCENARIO_PG_URL'],
    ['rag-recovery-db','RAG_RECOVERY_TEST_PG_URL'],
    ['remote-models-db','REMOTE_MODEL_TEST_PG_URL'],
    ['skill-audit-db','PUBLICATION_TEST_PG_URL'],
    ['skill-dependencies-db','PUBLICATION_TEST_PG_URL'],
    ['skill-directory-audit-db','PUBLICATION_TEST_PG_URL'],
    ['tool-build-db','TOOL_BUILD_TEST_PG_URL'],
    ['reliable-migrations','TEST_ADMIN_PG_URL'],
    ['maintenance-database','TEST_ADMIN_PG_URL'],
    ['install-plan-database','INSTALLATION_TEST_PG_URL'],
    ['installation-reliability','INSTALLATION_TEST_PG_URL'],
    ['dependency-installation','DEPENDENCY_INSTALLATION_PG_URL'],
];

/** Stop at the actual CLI's first Pool; SQL, sockets and child processes are never executed. */
function runEntry(name,variable,value,fixtureEnvironment={}){
    const own=mkdtempSync(path.join(tmpdir(),'nc-pg-admission-')),events=path.join(own,'events.jsonl'),hook=path.join(own,'capture.cjs');
    writeFileSync(hook,`
const fs=require('node:fs'),Module=require('node:module'),net=require('node:net'),child=require('node:child_process');
const record=event=>fs.appendFileSync(process.env.OWNED_PG_CAPTURE,JSON.stringify(event)+'\\n');
net.Socket.prototype.connect=function(){record({stage:'network'});throw Error('NETWORK_FORBIDDEN');};
for(const method of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])child[method]=()=>{record({stage:'child'});throw Error('CHILD_FORBIDDEN');};
const load=Module._load;
Module._load=function(request,parent,...rest){
    if(request==='pg')return {Pool:class{constructor(options){const url=new URL(options.connectionString);record({stage:'pool',protocol:url.protocol,host:url.hostname,port:url.port,database:url.pathname,search:url.search});throw Error('OWNED_PG_POOL_CAPTURE');}}};
    if(request==='typescript')return {};
    if(request==='ts-node')return {register(){}};
    if(request.startsWith('@nestjs/'))return {};
    // Admission has no dependency on compiled application modules; do not bootstrap services in this fixture.
    if(/services[\\\\/][^\\\\/]+[\\\\/](?:src|dist)[\\\\/]/.test(request)||request.startsWith('./src/'))return {};
    return load.call(this,request,parent,...rest);
};
`);
    // Deliberately exclude the caller's PostgreSQL, credentials and Node preload environment.
    const env={PATH:process.env.PATH,HOME:own,USERPROFILE:own,XDG_CONFIG_HOME:own,TMPDIR:own,OWNED_PG_CAPTURE:events,...fixtureEnvironment};
    if(value!==undefined)env[variable]=value;
    try{
        const result=spawnSync(process.execPath,['--require',hook,path.join(folder,name+'.mjs')],{env,cwd:own,encoding:'utf8',timeout:10000,maxBuffer:1024*1024});
        assert.equal(result.error,undefined);assert.equal(result.signal,null);assert.equal(result.status,1);
        return {...result,events:existsSync(events)?readFileSync(events,'utf8').trim().split('\n').map(line=>JSON.parse(line)):[]};
    }finally{rmSync(own,{recursive:true,force:true});}
}

const password='fixture-password-must-not-be-logged';
const valid='postgresql://qa:'+password+'@127.0.0.1:59234/postgres';
const rejected=[['missing',undefined],['main-port',valid.replace(':59234/',':5432/')],['query-host-override',valid+'?host=remote.test']];
for(const [name,variable]of entries){
    for(const [label,value]of rejected)test(name+' rejects '+label+' before constructing Pool',()=>{
        const result=runEntry(name,variable,value);
        assert.deepEqual(result.events,[],'Pool/query/network must remain untouched');
        assert.match(result.stderr,/explicitly owned/);
        assert.ok(!result.stderr.includes(password));
    });
    test(name+' admits an explicit owned /postgres URL to its first Pool without connecting',()=>{
        const result=runEntry(name,variable,valid);
        assert.deepEqual(result.events,[{stage:'pool',protocol:'postgresql:',host:'127.0.0.1',port:'59234',database:'/postgres',search:''}]);
        assert.match(result.stderr,/OWNED_PG_POOL_CAPTURE/);
        assert.ok(!result.stderr.includes(password));
    });
}
test('rag-recovery-db ignores an application PostgreSQL URL without explicit test admission',()=>{
    const result=runEntry('rag-recovery-db','RAG_RECOVERY_TEST_PG_URL',undefined,{CATALOG_PG_URL:valid});
    assert.deepEqual(result.events,[]);assert.match(result.stderr,/explicitly owned/);
    assert.ok(!result.stderr.includes(password));
});
for(const name of ['dev-model-credentials-db','dev-snapshots-db','production-model-credentials-db'])test(name+' requires /postgres rather than an application /catalog URL',()=>{
    const result=runEntry(name,'CATALOG_TEST_PG_URL',valid.replace('/postgres','/catalog'));
    assert.deepEqual(result.events,[]);assert.match(result.stderr,/explicitly owned/);
    assert.ok(!result.stderr.includes(password));
});
