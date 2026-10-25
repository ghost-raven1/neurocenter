import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {activeIdentity,executeLiveRun,preflightLiveRun,nativeInvocation,inventoryLiveRun,prepareLiveRun} from '../evals/live-runner.mjs';
import {classifyPreflight,disabledFeatures} from '../evals/live-preflight.mjs';
import {fixtureRun} from './live-preflight.fixture.mjs';

const sha=text=>createHash('sha256').update(text).digest('hex');
async function blocked(run){
    let calls=0;await assert.rejects(executeLiveRun(run.id,{invoke:async()=>{calls++;throw Error('must not start');}}));
    assert.equal(calls,0);await assert.rejects(fs.stat(path.join(run.directory,'started.json')),{code:'ENOENT'});
}
async function readCaptures(run,receipt){
    const read=async item=>JSON.parse(await fs.readFile(path.join(run.directory,item.file),'utf8'));
    return {version:await read(receipt.captures.version),catalog:await read(receipt.captures.catalog),entries:await Promise.all(receipt.captures.entries.map(async entry=>({scenario:entry.scenario,features:await read(entry.features),mcp:await read(entry.mcp),prompt:await read(entry.prompt)})))};
}

test('bounded identity rejects catalog and provider routing overrides before preparation',()=>{
    const identity='model = "configured-model"\nmodel_reasoning_effort = "ultra"\n';
    for(const override of ['model_catalog_json = "/private/catalog.json"\n','chatgpt_base_url = "https://example.invalid"\n','[model_providers.openai]\nbase_url = "https://example.invalid"\n','"model_catalog_json" = "/private/catalog.json"\n',"[model_providers.'openai']\nbase_url = 'https://example.invalid'\n",'"model_provider" = "custom"\n','"openai_base_url" = "https://example.invalid"\n',"'model_provider' = 'custom'\n",'model_provider.alias = "custom"\n'])
        assert.throws(()=>activeIdentity(identity+override));
});

test('live execution without preflight starts no scenario and creates no budget marker',async t=>{
    await blocked(await fixtureRun(t));
});

test('metadata capture uses only fixed commands across six isolated homes and grants no inference access',async t=>{
    const run=await fixtureRun(t),receipt=await preflightLiveRun(run.id);
    assert.equal(receipt.status,'compatible');assert.equal(receipt.access,'unverified');assert.equal(receipt.modelCalls,0);
    assert.equal(receipt.cli.path,run.cli);assert.equal(receipt.cliVersion,'codex-cli fixture-1.0');
    const info=await fs.stat(path.join(run.directory,'preflight.json'));assert.equal(info.mode&0o077,0);
    const calls=(await fs.readFile(run.calls,'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(calls.length,20);assert.equal(new Set(calls.map(call=>call.home)).size,6);assert.equal(new Set(calls.map(call=>call.cwd)).size,6);
    for(const call of calls){
        assert.ok(run.plan.entries.some(entry=>entry.home===call.home&&entry.workspace===call.cwd));
        assert.ok(call.args[0]==='--version'||JSON.stringify(call.args)==='["debug","models","--bundled"]'||JSON.stringify(call.args)==='["features","list"]'||JSON.stringify(call.args)==='["mcp","list","--json"]'||call.args[0]==='debug'&&call.args[1]==='prompt-input');
    }
    for(const entry of run.plan.entries)assert.deepEqual(calls.filter(call=>call.home===entry.home&&['features','mcp'].includes(call.args[0])).map(call=>call.args[0]),['features','mcp']);
    const results=await readCaptures(run,receipt);
    for(const mutate of [
        value=>{value.catalog.stdout=JSON.stringify({models:[{slug:'gpt-6.1-sol-alias',supported_reasoning_levels:[{effort:'ultra'}]}]});},
        value=>{value.catalog.stdout=JSON.stringify({models:[{slug:'gpt-6.1-sol',supported_reasoning_levels:[{effort:'high'}]}]});},
        value=>{value.entries[5].features.stdout=value.entries[5].features.stdout.replace('apps stable false','apps stable true');},
        value=>{value.entries[5].features.stdout=value.entries[5].features.stdout.replace('apps stable false\n','');},
        value=>{const servers=JSON.parse(value.entries[0].mcp.stdout);servers.push({...servers[0],name:'extra'});value.entries[0].mcp.stdout=JSON.stringify(servers);},
        value=>{const servers=JSON.parse(value.entries[4].mcp.stdout);servers[0].transport.args.push('extra');value.entries[4].mcp.stdout=JSON.stringify(servers);},
        value=>{const servers=JSON.parse(value.entries[3].mcp.stdout);servers[0].transport.command='/foreign/node';value.entries[3].mcp.stdout=JSON.stringify(servers);},
        value=>{value.entries[2].prompt.stdout='[]';},
        value=>{value.entries[2].prompt.stdout=value.entries[2].prompt.stdout.replace('read-only','danger-full-access');},
        value=>{value.entries[1].prompt.stdout=value.entries[1].prompt.stdout.replace('currently never','currently on-request');},
        value=>{value.entries[3].prompt.stdout=value.entries[3].prompt.stdout.replace(run.plan.entries[3].workspace,'/foreign/workspace');},
        value=>{const messages=JSON.parse(value.entries[4].prompt.stdout);messages[0].role='user';value.entries[4].prompt.stdout=JSON.stringify(messages);},
        value=>{const messages=JSON.parse(value.entries[4].prompt.stdout);messages[1].role='developer';value.entries[4].prompt.stdout=JSON.stringify(messages);},
        value=>{const messages=JSON.parse(value.entries[0].prompt.stdout);messages.splice(0,2);value.entries[0].prompt.stdout=JSON.stringify(messages);},
    ]){const changed=structuredClone(results);mutate(changed);assert.equal(classifyPreflight(run.plan,changed).status,'incompatible');}
    for(const mutate of [
        value=>{value.version.code=1;},value=>{value.catalog.stdout='null';},value=>{value.entries[1].mcp.stdout='not json';},
        value=>{value.entries[0].features.cleanup.noLiveDescendants=false;},value=>{value.entries[2].prompt.leaderReaped=false;},
        value=>{value.version.stderr='Warning';},value=>{value.entries[5].features.stdout='apps stable unknown\n';},
    ]){const changed=structuredClone(results);mutate(changed);assert.equal(classifyPreflight(run.plan,changed).status,'unknown');}
    assert.equal(disabledFeatures.length,16);
});

test('stale, modified, oversized, linked or incompatible receipts consume zero scenario budget',async t=>{
    const run=await fixtureRun(t),receipt=await preflightLiveRun(run.id),file=path.join(run.directory,'preflight.json'),original=await fs.readFile(file,'utf8');
    for(const change of [value=>{value.createdAt=new Date(Date.now()-16*60000).toISOString();value.expiresAt=new Date(Date.parse(value.createdAt)+15*60000).toISOString();},
        value=>{value.status='incompatible';},value=>{value.identity.model='alias';},value=>{value.planSha256='0'.repeat(64);},value=>{value.versions.kitVersion='changed';}]){
        const changed=structuredClone(receipt);change(changed);await fs.writeFile(file,JSON.stringify(changed));await blocked(run);
    }
    await fs.writeFile(file,' '.repeat(128*1024+1));await blocked(run);
    await fs.writeFile(file,original);await fs.chmod(file,0o644);await blocked(run);await fs.chmod(file,0o600);
    const copy=path.join(run.directory,'receipt-copy.json');await fs.rename(file,copy);await fs.symlink(copy,file);await blocked(run);await fs.unlink(file);await fs.rename(copy,file);
});

test('capture hashes and owned-file reads are checked again, and recorded compatibility cannot hide bad captures',async t=>{
    const run=await fixtureRun(t),receipt=await preflightLiveRun(run.id),file=path.join(run.directory,'preflight.json'),original=await fs.readFile(file,'utf8');
    const capture=receipt.captures.entries[0].features,target=path.join(run.directory,capture.file),raw=await fs.readFile(target,'utf8');
    await fs.writeFile(target,raw+' ');await blocked(run);
    const changed=JSON.parse(raw);changed.stdout=changed.stdout.replace('apps stable false','apps stable true');
    const text=JSON.stringify(changed);await fs.writeFile(target,text);capture.sha256=sha(text);await fs.writeFile(file,JSON.stringify(receipt));await blocked(run);
    await fs.writeFile(file,original);await fs.writeFile(target,raw);
    const copy=target+'.owned';await fs.rename(target,copy);await fs.symlink(copy,target);await blocked(run);await fs.unlink(target);await fs.rename(copy,target);
});

test('PATH or executable changes invalidate admission before the marker',async t=>{
    const run=await fixtureRun(t);await preflightLiveRun(run.id);
    const previous=process.env.PATH;process.env.PATH=previous+path.delimiter+'/nonexistent';await blocked(run);process.env.PATH=previous;
    await fs.appendFile(run.cli,'\n// binary changed\n');await blocked(run);
});

test('a compatible receipt admits a scenario using the pinned executable and terminal cleanup still runs',async t=>{
    const run=await fixtureRun(t);await preflightLiveRun(run.id);let calls=0;
    const receipt=await executeLiveRun(run.id,{invoke:async(args,options)=>{calls++;assert.equal(options.executable,run.cli);throw Error('controlled fixture host stop');}});
    assert.equal(calls,1);assert.equal(receipt.attempted,1);assert.equal(receipt.privateAuthCopiesRemoved,true);
    assert.equal(JSON.parse(await fs.readFile(path.join(run.directory,'started.json'),'utf8')).budget,6);
});

test('metadata subprocess errors produce an unusable receipt rather than spending a scenario',async t=>{
    const run=await fixtureRun(t);await fs.writeFile(run.controls,JSON.stringify({features:{code:1,stdout:'invalid'}}));
    const receipt=await preflightLiveRun(run.id);assert.equal(receipt.status,'unknown');assert.equal(receipt.modelCalls,0);await blocked(run);
});

test('strict feature flag disables prepare, inventory and preflight before any run/config access',async()=>{
    const previous=process.env.NEUROCENTER_AGENT_EVALS;
    try{for(const value of ['0','false','yes']){
        process.env.NEUROCENTER_AGENT_EVALS=value;
        for(const operation of [prepareLiveRun,inventoryLiveRun,preflightLiveRun])await assert.rejects(operation('missing-run'),/evaluation (flag|is disabled)/);
    }}finally{if(previous===undefined)delete process.env.NEUROCENTER_AGENT_EVALS;else process.env.NEUROCENTER_AGENT_EVALS=previous;}
});

test('native wrapper uses an explicit absolute executable even when PATH points elsewhere',async t=>{
    const run=await fixtureRun(t),previous=process.env.PATH;process.env.PATH='/nonexistent';
    try{const result=await nativeInvocation(['--version'],{home:run.plan.entries[0].home,cwd:run.plan.entries[0].workspace,executable:run.cli,timeoutMs:10000});assert.equal(result.ok,true);assert.equal(result.stdout,'codex-cli fixture-1.0\n');}
    finally{process.env.PATH=previous;}
});
