import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {expectedBridgeLauncher} from '../workspace/dev-bridge-settings.mjs';
import {fixture,update,unchanged,jsonc} from './dev-bridge-install.fixture.mjs';

/** Management ACKs/launcher are controlled; updater, archive, JSONC init and file publication are real. */
function management(f,{paused=true,lost=false,refuseFinish=false}={}){
    const run=f.dependencies.runCommand,calls=[];
    f.dependencies.runCommand=async(command,args,environment,timeout)=>{
        const mode=args[1];calls.push(mode);
        if(mode==='--prepare-upgrade'){
            if(lost)throw Error('Owned prepare ACK lost');
            return JSON.stringify({ok:true,paused});
        }
        if(mode==='--finish-upgrade'){
            if(refuseFinish)throw Object.assign(Error('Owned identity401: MCP не подключён или доступ отозван'),{status:401});
            return '{"ok":true}';
        }
        if(mode==='--install-command'){
            await fs.writeFile(f.launcher,expectedBridgeLauncher(f.install));return f.launcher;
        }
        return run(command,args,environment,timeout);
    };
    return calls;
}

test('Confirmed paused:false publishes a paired dev update without invoking a revoked identity finish',()=>fixture(async f=>{
    const credentials=await fs.readFile(path.join(f.state,'credentials.json')),workspace=await fs.readFile(path.join(f.state,'workspace.json'));
    const calls=management(f,{paused:false,refuseFinish:true}),result=await update(f);
    assert.equal(result.updated,true);assert.equal(calls.filter(mode=>mode==='--prepare-upgrade').length,1);
    assert.equal(calls.includes('--finish-upgrade'),false);assert.equal(f.starts.length,1);
    assert.equal(JSON.parse(await fs.readFile(path.join(f.install,'dist/build.json'),'utf8')).buildId,f.buildId);
    assert.deepEqual(await fs.readFile(path.join(f.state,'credentials.json')),credentials);
    assert.deepEqual(await fs.readFile(path.join(f.state,'workspace.json')),workspace);
    const config=jsonc.parse(await fs.readFile(f.config,'utf8'));
    assert.equal(config.mcp['neurocenter-asset-sync'].enabled,false);assert.deepEqual(config.mcp['neurocenter-asset-sync'].environment,f.entry.environment);
    assert.equal(config.model,'user-model');assert.deepEqual(config.agent,{external:{description:'do not replace'}});
    assert.equal(await fs.readFile(path.join(result.previousDir,'keep.txt'),'utf8'),'old runtime');
}));

test('Confirmed paused:true still finishes exactly once before a paired dev worker starts',()=>fixture(async f=>{
    const calls=management(f),start=f.dependencies.startWorker;
    f.dependencies.startWorker=(...args)=>{assert.equal(calls.filter(mode=>mode==='--finish-upgrade').length,1);return start(...args);};
    assert.equal((await update(f)).updated,true);assert.equal(calls.filter(mode=>mode==='--finish-upgrade').length,1);
}));

test('Unknown prepare ACK still compensates once and preserves the prior installed files and pairing',()=>fixture(async f=>{
    const credentials=await fs.readFile(path.join(f.state,'credentials.json')),calls=management(f,{lost:true});
    await assert.rejects(update(f),/Owned prepare ACK lost/);
    assert.equal(calls.filter(mode=>mode==='--finish-upgrade').length,1);assert.equal(f.starts.length,0);
    await unchanged(f);assert.deepEqual(await fs.readFile(path.join(f.state,'credentials.json')),credentials);
}));
