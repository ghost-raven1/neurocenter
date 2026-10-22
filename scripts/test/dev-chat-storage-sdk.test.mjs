import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createServer} from 'node:http';
import {createHash,createHmac} from 'node:crypto';
import {createRequire} from 'node:module';
import {prepareDevChatStorage} from '../workspace/dev-chat-storage.mjs';

const repository=path.resolve(import.meta.dirname,'../..');
const require=createRequire(path.join(repository,'services/catalog-service/package.json'));
const ts=require('typescript'),digest=value=>createHash('sha256').update(value).digest('hex');
const hmac=(key,value)=>createHmac('sha256',key).update(value).digest();

/** Check the real SDK signature without retaining authorization headers or key values. */
function signed(request,access,secret){
    const match=/^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/us-east-1\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([a-f0-9]{64})$/.exec(request.headers.authorization||'');
    if(!match||match[1]!==access)return false;
    const [, ,date,names,signature]=match,headers=names.split(';'),timestamp=request.headers['x-amz-date'];
    if(!headers.includes('host')||!headers.includes('x-amz-date')||request.headers['x-amz-content-sha256']!==digest(''))return false;
    const url=new URL(request.url,'http://fixture'),query=[...url.searchParams].sort(([a],[b])=>a.localeCompare(b)).map(([key,value])=>encodeURIComponent(key)+'='+encodeURIComponent(value)).join('&');
    const canonicalHeaders=headers.map(name=>name+':'+String(request.headers[name]).trim().replace(/[ \t]+/g,' ')+'\n').join('');
    const canonical=[request.method,url.pathname,query,canonicalHeaders,names,digest('')].join('\n'),scope=date+'/us-east-1/s3/aws4_request';
    const key=hmac(hmac(hmac(hmac('AWS4'+secret,date),'us-east-1'),'s3'),'aws4_request');
    return hmac(key,['AWS4-HMAC-SHA256',timestamp,scope,digest(canonical)].join('\n')).toString('hex')===signature;
}

async function fixture(t,mode='private'){
    const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nc-chat-sdk-'))),calls=[],requests=[],warnings=[];
    let server;
    t.after(async()=>{
        if(server){server.closeAllConnections();await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));assert.equal(server.listening,false);}
        await fs.rm(root,{recursive:true,force:true});await assert.rejects(fs.lstat(root),{code:'ENOENT'});
    });
    const catalog=path.join(root,'services/catalog-service'),shared=path.join(root,'services/shared');
    await fs.mkdir(path.join(catalog,'dist/model-chat'),{recursive:true});await fs.mkdir(shared,{recursive:true});
    await fs.writeFile(path.join(catalog,'package.json'),'{"type":"commonjs"}');
    await fs.symlink(path.join(repository,'services/catalog-service/node_modules'),path.join(catalog,'node_modules'));
    // Compile this checkout's class, so the test never imports a possibly stale working dist.
    const source=await fs.readFile(path.join(repository,'services/catalog-service/src/model-chat/chat-object-storage.ts'),'utf8');
    const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2021,esModuleInterop:true},reportDiagnostics:true});
    assert.equal(compiled.diagnostics.length,0);
    await fs.writeFile(path.join(catalog,'dist/model-chat/chat-object-storage.js'),compiled.outputText);
    await fs.copyFile(path.join(repository,'services/shared/s3-bucket-privacy.cjs'),path.join(shared,'s3-bucket-privacy.cjs'));
    const keys=path.join(root,'.run/ceph-chat-storage/credentials');
    server=createServer(async(request,response)=>{
        try{
            const [access,secret]=await Promise.all(['access-key','secret-key'].map(name=>fs.readFile(path.join(keys,name),'utf8').then(value=>value.trim())));
            const valid=signed(request,access,secret),url=new URL(request.url,'http://fixture');requests.push({method:request.method,path:url.pathname,query:url.search,valid});
            if(!valid||mode==='denied'){response.writeHead(403,{'content-type':'application/xml'});response.end('<Error><Code>AccessDenied</Code></Error>');return;}
            if(request.method==='HEAD'&&!url.search){response.writeHead(200);response.end();return;}
            if(request.method==='GET'&&url.search==='?policy'){
                if(mode==='public'){response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({Statement:[{Effect:'Allow',Principal:'*',Action:'s3:GetObject',Resource:'arn:aws:s3:::fixture/*'}]}));}
                else{response.writeHead(404,{'content-type':'application/xml'});response.end('<Error><Code>NoSuchBucketPolicy</Code></Error>');}return;
            }
            if(request.method==='GET'&&url.search==='?acl'){response.writeHead(200,{'content-type':'application/xml'});response.end('<AccessControlPolicy><Owner><ID>owner</ID></Owner><AccessControlList><Grant><Grantee xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="CanonicalUser"><ID>owner</ID></Grantee><Permission>FULL_CONTROL</Permission></Grant></AccessControlList></AccessControlPolicy>');return;}
            response.writeHead(500);response.end();
        }catch{response.writeHead(500);response.end();}
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;
    const dependencies={output:{warning:message=>warnings.push(message),info(){}},run(command,args){calls.push({command,args});return args[0]==='volume'?{status:0,stdout:''}:{status:0};}};
    return{root,calls,requests,warnings,keys,dependencies,environment:{NODE_ENV:'development',CHAT_DEV_S3_PORT:String(port)}};
}

test('Local preparation checks both private buckets through the current compiled class and real signed SDK',async t=>{
    const f=await fixture(t),result=await prepareDevChatStorage(f.root,f.environment,f.dependencies);
    assert.equal(result.CHAT_S3_ENDPOINT,'http://127.0.0.1:'+f.environment.CHAT_DEV_S3_PORT);
    assert.equal(f.calls.filter(call=>call.args.includes('up')).length,1);assert.deepEqual(f.warnings,[]);
    assert.equal(f.requests.length,6);assert(f.requests.every(request=>request.valid));
    for(const bucket of [result.CHAT_S3_PROJECT_BUCKET,result.CHAT_S3_PERSONAL_BUCKET])assert.deepEqual(f.requests.filter(request=>request.path==='/'+bucket).map(({method,query})=>[method,query]),[['HEAD',''],['GET','?policy'],['GET','?acl']]);
    assert(f.requests.every(request=>['HEAD','GET'].includes(request.method)));
});

test('The real signed public-bucket rejection does not export local credentials or replace the retry identity',async t=>{
    const f=await fixture(t,'public');assert.deepEqual(await prepareDevChatStorage(f.root,f.environment,f.dependencies),{});
    const before=await Promise.all(['access-key','secret-key'].map(name=>fs.readFile(path.join(f.keys,name))));
    assert.equal(f.requests.length,2);assert(f.requests.every(request=>request.valid));assert.match(f.warnings[0],/приватность/);
    assert.deepEqual(await prepareDevChatStorage(f.root,f.environment,f.dependencies),{});
    assert.deepEqual(await Promise.all(['access-key','secret-key'].map(name=>fs.readFile(path.join(f.keys,name)))),before);
    assert.equal(f.calls.filter(call=>call.args[0]==='volume').length,1);
});

test('An external endpoint denied by the real SDK remains an error without Docker or local fallback',async t=>{
    const f=await fixture(t,'denied');await fs.mkdir(f.keys,{recursive:true,mode:0o700});
    for(const [name,value]of [['access-key','external-access-key'],['secret-key','external-secret-key']])await fs.writeFile(path.join(f.keys,name),value,{mode:0o600});
    const external={NODE_ENV:'development',CHAT_DEV_CEPH:'false',CHAT_S3_ENDPOINT:'http://127.0.0.1:'+f.environment.CHAT_DEV_S3_PORT,
        CHAT_S3_PROJECT_BUCKET:'external-projects',CHAT_S3_PERSONAL_BUCKET:'external-personal',CHAT_S3_ACCESS_KEY_FILE:path.join(f.keys,'access-key'),CHAT_S3_SECRET_KEY_FILE:path.join(f.keys,'secret-key')};
    await assert.rejects(prepareDevChatStorage(f.root,external,f.dependencies),error=>error.name==='ServiceUnavailableException');
    assert.equal(f.requests.length,1);assert.equal(f.requests[0].valid,true);assert.deepEqual(f.calls,[]);assert.deepEqual(f.warnings,[]);
    assert.equal(await fs.readFile(path.join(f.keys,'secret-key'),'utf8'),'external-secret-key');
});

for(const [name,result]of [['signal',{status:0,signal:'SIGTERM',stdout:''}],['non-text',{status:0,stdout:[]}],['missing output',{status:0}],['malformed output',{status:0,stdout:'not a volume name\n'}]]){
    test('Unknown Docker volume inventory preserves absence of keys: '+name,async t=>{
        const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nc-chat-inventory-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));let calls=0;
        assert.deepEqual(await prepareDevChatStorage(root,{}, {run(){calls++;return result;}}),{});
        assert.equal(calls,1);await assert.rejects(fs.lstat(path.join(root,'.run/ceph-chat-storage/credentials')),{code:'ENOENT'});
    });
}
