import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {installerLifecycleFixture} from './bridge-installer-lifecycle.fixture.mjs';
import {maintenanceFixture,revokedMessage} from './bridge-maintenance-native.fixture.mjs';

const exec=promisify(execFile),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}};
const nativeKeys=['BRIDGE_MAINTENANCE_CONNECTION_FILE','BRIDGE_MAINTENANCE_CANDIDATE','BRIDGE_MAINTENANCE_OUTPUT'];
const nativeEnvironmentAbsent=nativeKeys.every(key=>process.env[key]===undefined);
if(!nativeEnvironmentAbsent)assert.ok(nativeKeys.every(key=>typeof process.env[key]==='string'&&process.env[key].trim()),'Set all three BRIDGE_MAINTENANCE_CONNECTION_FILE, BRIDGE_MAINTENANCE_CANDIDATE and BRIDGE_MAINTENANCE_OUTPUT explicitly.');

/** A real trigger holds the production pause transaction after its device row lock. */
async function pauseBarrier(f){
    const blocker=await f.pool.connect(),key=194728113;
    await f.pool.query(`CREATE FUNCTION qa_pause_barrier() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.paused_until IS NOT NULL AND NEW.paused_until IS DISTINCT FROM OLD.paused_until THEN PERFORM pg_advisory_xact_lock(${key}); END IF; RETURN NEW; END $$;
        CREATE TRIGGER qa_pause_barrier BEFORE UPDATE ON bridge_devices FOR EACH ROW EXECUTE FUNCTION qa_pause_barrier()`);
    await blocker.query('SELECT pg_advisory_lock($1)',[key]);let released=false;
    return{async release(){if(!released){released=true;await blocker.query('SELECT pg_advisory_unlock($1)',[key]);}},async close(){if(!released)await blocker.query('SELECT pg_advisory_unlock($1)',[key]);blocker.release();await f.pool.query('DROP TRIGGER qa_pause_barrier ON bridge_devices; DROP FUNCTION qa_pause_barrier()');}};
}

async function savedWorker(f,native,d){
    const home=path.join(f.root,'runtime-home'),bridgeHome=path.join(f.root,'runtime-state');
    const environment={HOME:home,NEUROCENTER_BRIDGE_HOME:bridgeHome,NEUROCENTER_URL:f.origin,NEUROCENTER_API_URL:native.origin,CUSTOM_SETTING:'retain exact'};
    const config=path.join(f.environment.XDG_CONFIG_HOME,'opencode/opencode.jsonc');
    const text='// Owned native maintenance profile\n'+JSON.stringify({agent:{mine:{mode:'subagent'}},mcp:{other:{type:'remote',url:'https://other.example.test'},'neurocenter-asset-sync':{type:'local',enabled:false,command:[path.join(f.install,'bin/node'),path.join(f.install,'dist/index.js')],environment}}},null,2)+'\n';
    await fs.mkdir(path.dirname(config),{recursive:true});await fs.writeFile(config,text,{mode:0o640});
    const worker=await f.startWorker(environment),credentials=path.join(worker.directory,'credentials.json'),bytes=Buffer.from(JSON.stringify({deviceId:d.id,token:d.token}));
    await fs.writeFile(credentials,bytes,{mode:0o600});await fs.writeFile(path.join(worker.directory,'owned-journal.json'),'{"pending":"retain"}\n');
    native.control.artifact={version:f.version,bytes:await fs.readFile(path.join(f.root,'bridge.tgz'))};
    return{config,text,credentials,bytes,worker};
}
async function unchanged(f,saved){
    assert.equal(await fs.readFile(path.join(f.install,'previous.txt'),'utf8'),'owned old runtime');
    assert.equal(await fs.readFile(saved.config,'utf8'),saved.text);assert.deepEqual(await fs.readFile(saved.credentials),saved.bytes);
    assert.equal(await fs.readFile(path.join(saved.worker.directory,'owned-journal.json'),'utf8'),'{"pending":"retain"}\n');
    assert.equal(alive(saved.worker.pid),true);assert.equal(await fs.readFile(path.join(saved.worker.directory,'worker.lock'),'utf8'),String(saved.worker.pid));
}
async function bash(f,native){
    try{return{status:0,...await exec('/bin/bash',[path.join(f.root,'install.sh')],{env:{...f.environment,BASE_URL:native.origin+'/api/bridge',INSTALLER_FIXTURE_NATIVE_UPGRADE:'1'},encoding:'utf8',timeout:45000,maxBuffer:1024*1024})};}
    catch(error){if(typeof error.code!=='number')throw error;return{status:error.code,stdout:error.stdout,stderr:error.stderr};}
}

test('Native maintenance preserves a revoked bridge upgrade and refuses uncertain work',{timeout:180000,skip:nativeEnvironmentAbsent?'Requires explicitly owned PostgreSQL, candidate and output':false},async t=>{
    const f=await maintenanceFixture();
    const run=async(name,fn)=>t.test(name,async()=>{const result={name,startedAt:new Date().toISOString()};f.receipt.cases.push(result);try{await fn(result);result.ok=true;}catch(error){result.ok=false;result.error={name:error.name,message:error.message};throw error;}finally{result.finishedAt=new Date().toISOString();}});
    try{
        await run('Retained revoked, expired and role-lost keys retain maintenance alone',async result=>{
            result.states=[];
            for(const state of [{revoked:true},{revoked:false,expired:true},{revoked:false,roleLost:true}]){
                const d=await f.device(state);const ordinary=await f.post('identity',d.token);assert.ok([401,403].includes(ordinary.status));
                for(const route of ['heartbeat','jobs/claim','configuration-authorize'])assert.ok([401,403].includes((await f.post(route,d.token)).status));
                const pause=await f.post('worker/pause',d.token,{deviceId:'unrelated-device'});assert.equal(pause.status,201);assert.deepEqual(pause.body,{activeJobs:0});
                assert.equal((await f.pool.query('SELECT paused_until>now() AS paused FROM bridge_devices WHERE id=$1',[d.id])).rows[0].paused,true);
                assert.equal((await f.post('worker/resume',d.token)).status,201);
                assert.equal((await f.pool.query('SELECT paused_until FROM bridge_devices WHERE id=$1',[d.id])).rows[0].paused_until,null);
                result.states.push({state,ordinaryStatus:ordinary.status,maintenanceStatus:pause.status});
            }
        });
        await run('An unknown retained key cannot pause or resume an unrelated device',async()=>{
            const d=await f.device(),token=randomBytes(32).toString('hex');
            for(const route of ['worker/pause','worker/resume'])assert.equal((await f.post(route,token,{deviceId:d.id})).status,401);
            assert.equal((await f.pool.query('SELECT paused_until FROM bridge_devices WHERE id=$1',[d.id])).rows[0].paused_until,null);
        });
        await run('Actual SQL counts running, reconciling and revoked unknown failures including a non-null result',async result=>{
            const d=await f.device();await f.job(d,'running');await f.job(d,'reconciling');await f.job(d,'failed',revokedMessage,{partial:'unconfirmed'});await f.job(d,'failed','Confirmed ordinary failure',{finished:true});
            const response=await f.post('worker/pause',d.token);assert.equal(response.status,201);assert.deepEqual(response.body,{activeJobs:3});result.activeJobs=response.body.activeJobs;
            await f.post('worker/resume',d.token);
        });
        await run('Rotation that owns the row first invalidates an already waiting old-token pause',async result=>{
            const d=await f.device(),writer=await f.pool.connect();let pending;
            try{
                await writer.query('BEGIN');await writer.query('SELECT id FROM bridge_devices WHERE id=$1 FOR UPDATE',[d.id]);pending=f.post('worker/pause',d.token);
                result.blocked=await f.waitQuery(/^SELECT id FROM bridge_devices WHERE token_hash=/);
                await writer.query('UPDATE bridge_devices SET token_hash=$2 WHERE id=$1',[d.id,sha(randomBytes(32))]);await writer.query('COMMIT');
                assert.equal((await pending).status,401);assert.equal((await f.pool.query('SELECT paused_until FROM bridge_devices WHERE id=$1',[d.id])).rows[0].paused_until,null);
            }finally{await writer.query('ROLLBACK');writer.release();if(pending)await pending;}
        });
        await run('Pause owns its row until COMMIT and blocks a concurrent rotation',async result=>{
            const d=await f.device(),barrier=await pauseBarrier(f);let paused,rotated;
            try{
                paused=f.post('worker/pause',d.token);result.pauseBlocked=await f.waitQuery(/^UPDATE bridge_devices SET paused_until=/);
                rotated=f.pool.query('/* owned-token-rotation */ UPDATE bridge_devices SET token_hash=$2 WHERE id=$1',[d.id,sha(randomBytes(32))]);result.rotationBlocked=await f.waitQuery(/^\/\* owned-token-rotation \*\//);
                await barrier.release();assert.deepEqual((await paused).body,{activeJobs:0});await rotated;assert.equal((await f.post('worker/resume',d.token)).status,401);
            }finally{await barrier.release();await Promise.allSettled([paused,rotated].filter(Boolean));await barrier.close();}
        });
        await run('A queued claim waits for the same device row and observes the committed pause',async result=>{
            const d=await f.device({revoked:false}),jobId=await f.job(d,'queued'),barrier=await pauseBarrier(f);let paused,claimed;
            try{
                paused=f.post('worker/pause',d.token);result.pauseBlocked=await f.waitQuery(/^UPDATE bridge_devices SET paused_until=/);
                claimed=f.jobs.claim(d);result.claimBlocked=await f.waitQuery(/^SELECT id,paused_until>now\(\) AS paused FROM bridge_devices/);
                await barrier.release();assert.deepEqual((await paused).body,{activeJobs:0});assert.equal(await claimed,null);
                assert.equal((await f.pool.query('SELECT state FROM bridge_jobs WHERE id=$1',[jobId])).rows[0].state,'queued');
            }finally{await barrier.release();await Promise.allSettled([paused,claimed].filter(Boolean));await barrier.close();}
        });
        await run('Actual Bash upgrades a live revoked idle owner without granting normal identity',async result=>{
            const d=await f.device();assert.equal((await f.post('identity',d.token)).status,401);
            await installerLifecycleFixture('native-maintenance-idle',async shell=>{
                const saved=await savedWorker(shell,f,d),response=await bash(shell,f);assert.equal(response.status,0,response.stderr);assert.equal(alive(saved.worker.pid),false);
                assert.equal(JSON.parse(await fs.readFile(path.join(shell.install,'package.json'),'utf8')).version,shell.version);
                assert.equal(await fs.readFile(saved.config,'utf8'),saved.text);assert.deepEqual(await fs.readFile(saved.credentials),saved.bytes);
                assert.equal(await fs.readFile(path.join(saved.worker.directory,'owned-journal.json'),'utf8'),'{"pending":"retain"}\n');
                assert.equal((await f.pool.query('SELECT paused_until FROM bridge_devices WHERE id=$1',[d.id])).rows[0].paused_until,null);
                const calls=(await fs.readFile(shell.environment.INSTALLER_FIXTURE_EVENTS,'utf8')).trim().split('\n');assert.ok(calls.includes('--prepare-upgrade')&&calls.includes('--finish-upgrade')&&calls.includes('--connect-open'));result.cli=calls;
                assert.equal((await f.post('identity',d.token)).status,401);result.workerPid=saved.worker.pid;result.output={status:response.status,sha256:sha(response.stdout+response.stderr)};
            });
        });
        await run('Actual Bash refuses a busy revoked owner after the real 30-second deadline',async result=>{
            const d=await f.device();await f.job(d,'failed',revokedMessage,{localResult:'not reconciled'});
            await installerLifecycleFixture('native-maintenance-busy',async shell=>{
                const saved=await savedWorker(shell,f,d),started=Date.now(),response=await bash(shell,f);result.durationMs=Date.now()-started;assert.notEqual(response.status,0);assert.ok(result.durationMs>=29000&&result.durationMs<44000);
                await unchanged(shell,saved);assert.equal((await f.pool.query('SELECT paused_until FROM bridge_devices WHERE id=$1',[d.id])).rows[0].paused_until,null);
                const calls=(await fs.readFile(shell.environment.INSTALLER_FIXTURE_EVENTS,'utf8')).trim().split('\n');assert.ok(calls.includes('--prepare-upgrade'));assert.ok(!calls.includes('--init')&&!calls.includes('--connect-open'));result.cli=calls;result.workerPid=saved.worker.pid;
            });
        });
        await run('A lost real HTTP pause ACK compensates the queue without stopping or publishing',async result=>{
            const d=await f.device();
            await installerLifecycleFixture('native-maintenance-lost-ack',async shell=>{
                const saved=await savedWorker(shell,f,d),httpStart=f.receipt.http.length,dropsStart=f.control.pauseAckDrops.length;f.control.dropPauseAck=true;const response=await bash(shell,f);assert.notEqual(response.status,0);assert.equal(f.control.dropPauseAck,false);
                result.faults=f.control.pauseAckDrops.slice(dropsStart);assert.deepEqual(result.faults,[{status:201,activeJobs:0}]);
                result.http=f.receipt.http.slice(httpStart);
                for(const [service,route]of [['catalog','pause'],['catalog','resume'],['gateway','resume']])assert.ok(result.http.some(item=>item.service===service&&item.path.endsWith('/worker/'+route)&&item.status===201),'Accepted Catalog pause and successful compensation must be witnessed in this case');
                await unchanged(shell,saved);assert.equal((await f.pool.query('SELECT paused_until FROM bridge_devices WHERE id=$1',[d.id])).rows[0].paused_until,null);result.workerPid=saved.worker.pid;
            });
        });
    }finally{
        const receipt=await f.close();assert.equal(receipt.ownDatabaseDropped,true);assert.equal(receipt.originalDatabasesPreserved,true);assert.deepEqual(receipt.cleanupErrors,[]);
    }
});
