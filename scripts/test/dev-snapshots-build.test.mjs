import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {createHash,generateKeyPairSync} from 'node:crypto';
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {prepareDevSnapshots} from '../workspace/dev-snapshots.mjs';

const setting='SNAPSHOT_VERIFIER_BUILD_TIMEOUT_SECONDS',image='neurocenter-snapshot-verifier:local',digest='sha256:'+'a'.repeat(64);
const hash=value=>createHash('sha256').update(value).digest('hex');
const result=value=>({status:0,signal:null,error:undefined,stdout:'',stderr:'',...value});

/** Only the snapshot preflight runs: PostgreSQL and Docker are local stubs with recorded calls. */
async function fixture(t,{seed=true,build=result(),inspect=result({stdout:digest+'\n'})}={}){
    const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nc-snapshot-build-'))),calls=[];
    t.after(()=>fs.rm(root,{recursive:true,force:true}));
    const pg=path.join(root,'services/catalog-service/node_modules/pg'),events=path.join(root,'db-events.jsonl');
    await fs.mkdir(pg,{recursive:true});await fs.writeFile(path.join(pg,'package.json'),JSON.stringify({name:'pg',main:'index.cjs'}));
    await fs.writeFile(path.join(pg,'index.cjs'),`const fs=require('node:fs');
        const record=value=>fs.appendFileSync(${JSON.stringify(events)},JSON.stringify(value)+'\\n');
        exports.Client=class{
            constructor(){record({kind:'constructor'});}
            async connect(){record({kind:'connect'});}
            async query(sql){record({kind:'query',sql});return {rows:sql.includes('to_regclass')?[{snapshots:null,profiles:null}]:[]};}
            async end(){record({kind:'end'});}
        };`);
    const keyFile=path.join(root,'.run/project-snapshots/secrets/signing.pem'),tokenFile=path.join(root,'.run/project-snapshots/secrets/verifier-token');
    const stateFile=path.join(root,'.run/processes.json'),saved=new Map();
    if(seed){
        await fs.mkdir(path.dirname(keyFile),{recursive:true,mode:0o700});
        const key=generateKeyPairSync('ed25519').privateKey.export({format:'pem',type:'pkcs8'});
        for(const [file,value]of [[keyFile,key],[tokenFile,'c'.repeat(64)+'\n'],[stateFile,JSON.stringify([{name:'catalog',pid:123456,identity:'owned-existing-generation'}])+'\n']]){
            await fs.writeFile(file,value,{mode:0o600});saved.set(file,hash(value));
        }
    }
    const original=childProcess.spawnSync;
    childProcess.spawnSync=(command,args,options)=>{
        assert.equal(command,'docker');calls.push({command,args:[...args],options});
        if(args[0]==='build')return typeof build==='function'?build(options):build;
        assert.deepEqual(args,['image','inspect',image,'--format','{{.Id}}']);return inspect;
    };
    syncBuiltinESMExports();t.after(()=>{childProcess.spawnSync=original;syncBuiltinESMExports();});
    const environment={PATH:'/owned/no-executables',HOME:root,CATALOG_PG_URL:'postgresql://stub.invalid/never-connect',SNAPSHOT_MAX_BYTES:'21474836480'};
    const unchanged=async()=>{for(const [file,sha]of saved)assert.equal(hash(await fs.readFile(file)),sha,path.basename(file)+' changed');};
    const dbEvents=async()=>fs.readFile(events,'utf8').then(value=>value.trim().split('\n').filter(Boolean).map(JSON.parse),error=>{if(error.code==='ENOENT')return[];throw error;});
    return{root,calls,keyFile,tokenFile,stateFile,environment,unchanged,dbEvents};
}

for(const seconds of [undefined,'1800'])test('snapshot Docker build uses explicit finite timeout and kill signal: '+(seconds??'default'),async t=>{
    const f=await fixture(t),env={...f.environment,...(seconds===undefined?{}:{[setting]:seconds})};
    const prepared=await prepareDevSnapshots(f.root,env),build=f.calls.find(call=>call.args[0]==='build');
    assert.equal(f.calls.length,2);assert.equal(build.options.timeout,Number(seconds??600)*1000);assert.equal(build.options.killSignal,'SIGKILL');
    assert.equal(build.options.cwd,f.root);assert.equal(build.options.stdio,'inherit');
    assert.deepEqual(build.args,['build','-f','services/catalog-service/snapshot-verifier.Dockerfile','-t',image,'.']);
    assert.equal(prepared.catalog.SNAPSHOT_VERIFIER_IMAGE_DIGEST,digest);assert.equal(prepared.runner.SNAPSHOT_RUNNER_IMAGE,digest);
    assert.equal(prepared.catalog.SNAPSHOT_SIGNING_KEY_FILE,f.keyFile);assert.equal(prepared.catalog.SNAPSHOT_VERIFIER_TOKEN_FILE,f.tokenFile);
    assert.equal(prepared.runner.SNAPSHOT_RUNNER_TOKEN_FILE,f.tokenFile);assert.equal(prepared.runner.SNAPSHOT_SIGNING_KEY_FILE,undefined);
    assert.equal(prepared.catalog.SNAPSHOT_MAX_BYTES,env.SNAPSHOT_MAX_BYTES);assert.equal(prepared.runner.SNAPSHOT_MAX_BYTES,env.SNAPSHOT_MAX_BYTES);
    assert.equal(prepared.catalog[setting],undefined);assert.equal(prepared.runner[setting],undefined);assert.deepEqual(env,{...f.environment,...(seconds===undefined?{}:{[setting]:seconds})});
    await f.unchanged();assert.ok((await f.dbEvents()).some(event=>event.kind==='end'));
});

for(const seconds of [undefined,'1800'])test('snapshot build timeout names its configured seconds and preserves the original cause: '+(seconds??'default'),async t=>{
    const timeout=Object.assign(Error('spawnSync docker ETIMEDOUT'),{code:'ETIMEDOUT'}),f=await fixture(t,{build:result({error:timeout,status:null,signal:'SIGKILL'})});
    await assert.rejects(prepareDevSnapshots(f.root,{...f.environment,...(seconds===undefined?{}:{[setting]:seconds})}),error=>{
        assert.equal(error.cause,timeout);assert.match(error.message,new RegExp((seconds??'600')+'\\s*с'));assert.match(error.message,/тайм|врем|timeout/iu);
        assert.ok(error.message.includes(setting));return true;
    });
    assert.equal(f.calls.length,1);assert.equal(f.calls[0].args[0],'build');await f.unchanged();
});

test('native timeout kills and reaps an owned child that ignores SIGTERM without inspecting the image',async t=>{
    const realSpawnSync=childProcess.spawnSync;let nativeResult;
    const f=await fixture(t,{build:options=>{
        nativeResult=realSpawnSync(process.execPath,['-e',"process.on('SIGTERM',()=>{});setTimeout(()=>process.exit(0),3000);"],options);
        return nativeResult;
    }});
    await assert.rejects(prepareDevSnapshots(f.root,{...f.environment,[setting]:'1'}),error=>{
        assert.equal(error.cause,nativeResult.error);assert.equal(error.cause.code,'ETIMEDOUT');
        assert.ok(error.message.includes(setting));return true;
    });
    assert.equal(f.calls.length,1);assert.equal(f.calls[0].options.timeout,1000);assert.equal(f.calls[0].options.killSignal,'SIGKILL');
    assert.equal(nativeResult.signal,'SIGKILL');assert.equal(nativeResult.status,null);assert.ok(Number.isSafeInteger(nativeResult.pid)&&nativeResult.pid>0);
    assert.throws(()=>process.kill(nativeResult.pid,0),{code:'ESRCH'});await f.unchanged();
});

for(const [name,build,pattern]of [
    ['exit status',result({status:37}),/37/],
    ['signal',result({status:null,signal:'SIGKILL'}),/SIGKILL/],
    ['missing Docker',result({status:null,error:Object.assign(Error('spawnSync docker ENOENT'),{code:'ENOENT'})}),/ENOENT/],
])test('snapshot build failure distinguishes '+name+' and never inspects the image',async t=>{
    const f=await fixture(t,{build});
    await assert.rejects(prepareDevSnapshots(f.root,f.environment),error=>{
        assert.match(error.message,pattern);if(build.error)assert.equal(error.cause,build.error);return true;
    });
    assert.equal(f.calls.length,1);assert.equal(f.calls[0].args[0],'build');await f.unchanged();
});

test('an explicit snapshot image skips Docker build and still resolves its immutable digest',async t=>{
    const f=await fixture(t),prepared=await prepareDevSnapshots(f.root,{...f.environment,SNAPSHOT_VERIFIER_IMAGE:image,[setting]:'1800'});
    assert.equal(f.calls.length,1);assert.equal(f.calls[0].args[0],'image');assert.equal(prepared.runner.SNAPSHOT_RUNNER_IMAGE,digest);
    assert.equal(prepared.catalog[setting],undefined);assert.equal(prepared.runner[setting],undefined);await f.unchanged();
});

test('Docker inspect failure is classified separately and preserves its underlying error',async t=>{
    const failure=Object.assign(Error('spawnSync docker ENOENT'),{code:'ENOENT'}),f=await fixture(t,{inspect:result({status:null,error:failure})});
    await assert.rejects(prepareDevSnapshots(f.root,{...f.environment,SNAPSHOT_VERIFIER_IMAGE:image}),error=>{
        assert.equal(error.cause,failure);assert.match(error.message,/inspect|провер|образ/iu);assert.match(error.message,/ENOENT/);return true;
    });
    assert.equal(f.calls.length,1);assert.equal(f.calls[0].args[0],'image');await f.unchanged();
});

test('invalid inspect digest is an unavailable image, with existing identity and process state intact',async t=>{
    const f=await fixture(t,{inspect:result({stdout:'not-an-image-digest\n'})});
    await assert.rejects(prepareDevSnapshots(f.root,{...f.environment,SNAPSHOT_VERIFIER_IMAGE:image}),/образ|image/iu);
    assert.equal(f.calls.length,1);await f.unchanged();
});

for(const value of ['', 'not-seconds','0','-1','3601','1.5'])test('invalid snapshot build timeout '+JSON.stringify(value)+' fails before DB and secret creation',async t=>{
    const f=await fixture(t,{seed:false});
    await assert.rejects(prepareDevSnapshots(f.root,{...f.environment,[setting]:value}),error=>{assert.ok(error.message.includes(setting));return true;});
    assert.deepEqual(await f.dbEvents(),[]);assert.deepEqual(f.calls,[]);
    await assert.rejects(fs.stat(path.join(f.root,'.run')),{code:'ENOENT'});
});
