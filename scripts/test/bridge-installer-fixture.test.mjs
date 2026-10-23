import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {installerLifecycleFixture} from './bridge-installer-lifecycle.fixture.mjs';

const exec=promisify(execFile);
/** Tiny CLI dispatches real worker-upgrade functions; the idle worker is an owned process stub. */
async function native(f,mode){
    const entry=path.join(f.install,'dist/index.js');
    const result=await exec(process.execPath,[entry,mode,...(mode==='--prepare-upgrade'?[entry]:[])],{
        env:{...f.environment,NEUROCENTER_URL:f.origin,NEUROCENTER_API_URL:f.origin,INSTALLER_FIXTURE_NATIVE_UPGRADE:'1'},
        encoding:'utf8',timeout:12000,maxBuffer:65536,
    });
    return JSON.parse(result.stdout);
}

test('Native fixture reaches worker-upgrade and preserves paused:false without credentials or a worker',()=>installerLifecycleFixture('fixture-native-unpaused',async f=>{
    assert.deepEqual(await native(f,'--prepare-upgrade'),{ok:true,paused:false});
    assert.equal(f.state.requests.length,0);assert.equal(f.state.paused,false);
    assert.equal(await fs.readFile(path.join(f.install,'previous.txt'),'utf8'),'owned old runtime');
}));

test('Native fixture preserves actual paused:true and finishes the admitted pause after reaping its owned idle worker',()=>installerLifecycleFixture('fixture-native-paused',async f=>{
    const worker=await f.startWorker();
    assert.deepEqual(await native(f,'--prepare-upgrade'),{ok:true,paused:true});
    assert.throws(()=>process.kill(worker.pid,0),error=>error.code==='ESRCH');
    await assert.rejects(fs.stat(path.join(worker.directory,'worker.lock')),{code:'ENOENT'});
    assert.equal(f.state.paused,true);
    assert.deepEqual(f.state.requests.map(item=>item.route),['/api/device-channel/worker/pause']);
    assert.deepEqual(await native(f,'--finish-upgrade'),{ok:true});
    assert.equal(f.state.paused,false);
    assert.deepEqual(f.state.requests.map(item=>item.route),['/api/device-channel/worker/pause','/api/device-channel/worker/resume']);
    assert.equal(await fs.readFile(path.join(f.install,'previous.txt'),'utf8'),'owned old runtime');
}));
