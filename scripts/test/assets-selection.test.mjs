import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,lstat,symlink,mkdir,copyFile} from 'node:fs/promises';
import path from 'node:path';
import {PassThrough,Writable} from 'node:stream';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {assetFixture,clone,sha} from './assets-sync.fixture.mjs';
import {selectStartupAssets,parseAssetSelection} from '../assets/selection.mjs';
import {previousAssetSelection,saveAssetSelection} from '../assets/selection-state.mjs';
import {prepareStartupAssets} from '../assets/startup.mjs';
import {parseAssetsArguments} from '../assets/cli.mjs';

function session(f,{answers=[''],interactive=true,withoutModels=true,environment={},question}={}){
    const events=[],output=Object.fromEntries(['info','warning','success'].map(kind=>[kind,(...args)=>events.push([kind,...args])]));
    let questions=0;
    return {events,output,choose:()=>selectStartupAssets({root:f.root,environment,output,withoutModels,input:{isTTY:interactive},terminalOutput:{isTTY:interactive}},
        {request:f.fetch,question:question||(async()=>{questions++;assert.ok(answers.length,'Unexpected extra prompt');return answers.shift();})}),get questions(){return questions;}};
}
const saved=async(f,ids)=>saveAssetSelection(f.root,{pin:f.pin,ids,withoutModels:true});

test('TTY displays exact metadata and selects IDs before any binary download',async t=>{
    const f=await assetFixture(t),s=session(f,{answers:['1, 2']});
    const selection=await s.choose();assert.deepEqual(selection.ids,[f.tool.id,f.bridge.id]);
    assert.equal(selection.expectedCommit,f.pin.commit);assert.equal(selection.expectedRevision,f.pin.index.sha256);
    assert.ok(f.calls.length>0);assert.ok(f.calls.every(url=>url.startsWith(f.raw)));
    assert.ok(s.events.some(([,label,value])=>label.includes('Fixture plugin')&&value.includes('1.0.0')));
    assert.ok(s.events.some(([,label,value])=>label==='Загрузка'&&value.includes('карточки и установки не меняются')));
    assert.deepEqual((await previousAssetSelection(f.root)).selected,selection.ids);
    await assert.rejects(lstat(f.blob(f.tool.delivery.artifacts[0].descriptor.sha256)),{code:'ENOENT'});
});

test('Enter defaults to the previous startup receipt selection and never selects new IDs',async t=>{
    const f=await assetFixture(t);await f.run({ids:[f.bridge.id]});
    const s=session(f),choice=await s.choose();assert.deepEqual(choice.ids,[f.bridge.id]);
    assert.ok(s.events.some(([,label])=>label.includes('[x] Bridge')));
    assert.ok(s.events.some(([,label])=>label.includes('[ ] Fixture plugin')));
});

test('A first interactive Enter explicitly keeps an empty choice and leaves binary cache untouched',async t=>{
    const f=await assetFixture(t),s=session(f);assert.deepEqual((await s.choose()).ids,[]);
    assert.deepEqual((await previousAssetSelection(f.root)).selected,[]);
    assert.ok(f.calls.every(url=>url.startsWith(f.raw)));
});

test('Invalid numbers retry without losing prior intent; none saves an empty selection',async t=>{
    const f=await assetFixture(t);await saved(f,[f.bridge.id]);
    const s=session(f,{answers:['999','1; $(touch bad)','none']});assert.deepEqual((await s.choose()).ids,[]);
    assert.equal(s.questions,3);assert.equal(s.events.filter(([kind])=>kind==='warning').length,2);
    assert.deepEqual((await previousAssetSelection(f.root)).selected,[]);
});

test('Skip and EOF preserve the accepted selection for a later run',async t=>{
    const f=await assetFixture(t);await saved(f,[f.bridge.id]);const before=await readFile(path.join(f.root,'.run/assets-selection.json'));
    for(const answer of ['s',null])assert.equal((await session(f,{answers:[answer]}).choose()).skip,true);
    assert.deepEqual(await readFile(path.join(f.root,'.run/assets-selection.json')),before);
});

test('Without TTY, a fresh invocation retains the established CLI default and never opens a prompt',async t=>{
    const f=await assetFixture(t),s=session(f,{interactive:false});assert.deepEqual(await s.choose(),{});
    assert.equal(s.questions,0);assert.deepEqual(f.calls,[]);
});

test('Without TTY, stable selected IDs survive a new source pin and only their current versions download',async t=>{
    const f=await assetFixture(t);await saved(f,[f.tool.id]);await f.run({ids:[f.tool.id]});
    const next=clone(f.tool),bytes=Buffer.from('next selected version');next.version='2.0.0';next.card.revision='2.0.0';
    next.delivery.artifacts[0].url='https://github.com/example/assets/releases/download/v2.0.0/selected.tar.gz';
    next.delivery.artifacts[0].descriptor.sha256=sha(bytes);next.delivery.artifacts[0].descriptor.compressedBytes=bytes.length;f.payloads.set(next.delivery.artifacts[0].url,bytes);
    await f.publish([{asset:f.tool,current:false},next,f.bridge,f.skill,f.model]);f.calls.length=0;
    const s=session(f,{interactive:false}),choice=await s.choose();assert.deepEqual(choice.ids,[f.tool.id]);assert.equal(s.questions,0);
    assert.equal(choice.expectedRevision,f.pin.index.sha256);assert.ok(f.calls.every(url=>url.startsWith(f.raw)));
    const report=await f.run(choice);assert.equal(report.downloaded,1);assert.deepEqual(report.selected,[f.tool.id]);
    assert.ok(f.calls.includes(next.delivery.artifacts[0].url));assert.ok(!f.calls.includes(f.bridge.delivery.release.artifacts[0].url));
    await assert.rejects(lstat(f.blob(f.bridge.delivery.release.artifacts[0].metadata.sha256)),{code:'ENOENT'});
});

test('A changed pin shows an update on the retained selected ID in the interactive plan',async t=>{
    const f=await assetFixture(t);await f.run({ids:[f.tool.id]});const next=clone(f.tool);next.version='2.0.0';next.card.revision='2.0.0';
    await f.publish([next,f.bridge]);const s=session(f);assert.deepEqual((await s.choose()).ids,[f.tool.id]);
    assert.ok(s.events.some(([,label,value])=>label.includes('[x] Fixture plugin')&&value.includes('2.0.0')&&value.includes('обновление')));
});

test('Removed IDs are excluded; new IDs stay unselected even with no TTY',async t=>{
    const f=await assetFixture(t);await saved(f,[f.tool.id,f.bridge.id]);await f.publish([f.bridge,f.skill]);
    const s=session(f,{interactive:false});assert.deepEqual((await s.choose()).ids,[f.bridge.id]);
    assert.ok(s.events.some(([,label,value])=>label==='Прежний выбор'&&value.includes('Новые ID не добавлены')));
});

test('Standard excludes models and tools whose exact dependency requires a model',async t=>{
    const f=await assetFixture(t),tool=clone(f.tool);tool.dependencies=[{id:f.model.id,version:f.model.version,sha256:f.index.assets.find(entry=>entry.id===f.model.id).sha256}];
    await f.publish([tool,f.bridge,f.model]);const s=session(f,{answers:['1','all']});
    assert.deepEqual((await s.choose()).ids,[f.bridge.id]);assert.equal(s.questions,2);
    assert.ok(s.events.some(([,label,value])=>label.includes('Fixture plugin')&&value.includes('профиль full')));
    assert.ok(!s.events.some(([,label])=>label.includes('model-fixture')));
});
test('A legacy full saved selection cannot download weights when startup excludes models',async t=>{
    const f=await assetFixture(t);await saveAssetSelection(f.root,{pin:f.pin,ids:[f.model.id,f.tool.id],withoutModels:false});
    const choice=await session(f,{interactive:false,withoutModels:true}).choose();assert.deepEqual(choice.ids,[f.tool.id]);
    const report=await f.run({...choice,withoutModels:true});assert.equal(report.assets.some(asset=>asset.kind==='model'),false);
    assert.equal(f.calls.some(url=>url.startsWith(f.model.delivery.bundle.releaseBaseUrl+'/')),false);
});

test('Selected dependencies are automatic and exact; they are not new implicit selected IDs',async t=>{
    const f=await assetFixture(t),tool=clone(f.tool);tool.dependencies=[{id:f.bridge.id,version:f.bridge.version,sha256:f.index.assets.find(entry=>entry.id===f.bridge.id).sha256}];
    await f.publish([tool,f.bridge]);const choice=await session(f,{answers:['1']}).choose(),report=await f.run(choice);
    assert.deepEqual(report.selected,[f.tool.id]);assert.deepEqual(report.assets.map(asset=>asset.id),[f.bridge.id,f.tool.id]);
    assert.equal(report.downloaded,2);
});

test('Offline headless reuse reads only chosen cached metadata, without requiring descriptions of unselected assets',async t=>{
    const f=await assetFixture(t);await f.run({ids:[f.bridge.id]});await saved(f,[f.bridge.id]);f.calls.length=0;
    const choice=await session(f,{interactive:false,environment:{ASSET_SOURCE_MODE:'offline'}}).choose();
    assert.deepEqual(choice.ids,[f.bridge.id]);assert.deepEqual(f.calls,[]);
    const report=await f.run({...choice,environment:{ASSET_SOURCE_MODE:'offline'}});assert.equal(report.downloaded,0);
});

test('Unavailable metadata defers without replacing an accepted selection or readiness receipt',async t=>{
    const f=await assetFixture(t);await saved(f,[f.tool.id]);const before=await readFile(path.join(f.root,'.run/assets-selection.json'));
    const events=[],choice=await selectStartupAssets({root:f.root,environment:{},withoutModels:true,input:{isTTY:true},terminalOutput:{isTTY:true},output:{warning:value=>events.push(value)}},
        {request:async()=>{throw Error('controlled offline');},question:async()=>assert.fail('Unavailable source cannot prompt')});
    assert.deepEqual(choice,{skip:true,reason:'assets-unavailable'});assert.equal(events.length,1);
    assert.deepEqual(await readFile(path.join(f.root,'.run/assets-selection.json')),before);await assert.rejects(lstat(f.receipt),{code:'ENOENT'});
});

test('The bounded metadata deadline is a deferred source failure while an explicit abort stays cancelled',async t=>{
    const f=await assetFixture(t);await saved(f,[f.bridge.id]);
    const options={root:f.root,environment:{},withoutModels:true,input:{isTTY:true},terminalOutput:{isTTY:true},output:{warning(){}}};
    const result=await selectStartupAssets(options,{readSupply:async()=>{throw new DOMException('controlled deadline','TimeoutError');}});
    assert.deepEqual(result,{skip:true,reason:'assets-unavailable'});
    const cancelled=Object.assign(Error('controlled cancel'),{code:'ECANCELED',signal:'SIGINT'});
    await assert.rejects(selectStartupAssets(options,{readSupply:async()=>{throw cancelled;}}),error=>error===cancelled);
    assert.deepEqual((await previousAssetSelection(f.root)).selected,[f.bridge.id]);
});

test('Prompt cancellation propagates without resetting the previously accepted choice',async t=>{
    const f=await assetFixture(t);await saved(f,[f.bridge.id]);
    const cancelled=Object.assign(Error('controlled cancel'),{code:'ECANCELED',signal:'SIGINT'});
    await assert.rejects(session(f,{question:async()=>{throw cancelled;}}).choose(),error=>error===cancelled);
    assert.deepEqual((await previousAssetSelection(f.root)).selected,[f.bridge.id]);
});

test('An invalid metadata hash stays a hard failure and never opens a choice or downloads bytes',async t=>{
    const f=await assetFixture(t);f.payloads.set(f.raw+'index.json',Buffer.from('{}'));
    await assert.rejects(session(f).choose(),error=>error.code==='INVALID_SOURCE');
    assert.ok(f.calls.every(url=>url.startsWith(f.raw)));await assert.rejects(lstat(path.join(f.root,'.run/assets-selection.json')),{code:'ENOENT'});
});

test('The local off switch suppresses TTY interaction while retaining accepted IDs across pin changes',async t=>{
    const f=await assetFixture(t);await saved(f,[f.bridge.id]);await f.publish([f.bridge,f.skill]);
    const s=session(f,{environment:{ASSET_STARTUP_SELECTION:'off'}});assert.deepEqual((await s.choose()).ids,[f.bridge.id]);assert.equal(s.questions,0);
});

test('Prompt-time pin changes abort before intent replacement and binary fetch',async t=>{
    const f=await assetFixture(t);await saved(f,[f.bridge.id]);const before=await readFile(path.join(f.root,'.run/assets-selection.json'));
    const s=session(f,{question:async()=>{await f.publish([f.tool]);return'1';}});
    await assert.rejects(s.choose(),error=>error.code==='ASSET_SOURCE_CHANGED');assert.deepEqual(await readFile(path.join(f.root,'.run/assets-selection.json')),before);
    assert.ok(f.calls.every(url=>url.startsWith(f.raw)));
});

test('Expected-pin CLI values are complete and strict; ordinary CLI parsing remains unchanged',()=>{
    assert.deepEqual(parseAssetsArguments(['--asset','fixture-tool','--without-models']),{ids:['fixture-tool'],withoutModels:true});
    const args=['--expected-repository','example/assets','--expected-commit','a'.repeat(40),'--expected-revision','b'.repeat(64)];
    assert.deepEqual(parseAssetsArguments(args),{expectedRepository:'example/assets',expectedCommit:'a'.repeat(40),expectedRevision:'b'.repeat(64)});
    for(const invalid of [args.slice(0,2),args.slice(2),['--expected-commit','main'],[...args,'--expected-commit','a'.repeat(40)]])assert.throws(()=>parseAssetsArguments(invalid));
});

test('A mismatched expected source rejects before fetching even metadata',async t=>{
    const f=await assetFixture(t);
    await assert.rejects(f.run({ids:[f.tool.id],expectedRepository:f.pin.repository,expectedCommit:'b'.repeat(40),expectedRevision:f.pin.index.sha256}),error=>error.code==='ASSET_SOURCE_CHANGED');
    assert.deepEqual(f.calls,[]);await assert.rejects(lstat(f.receipt),{code:'ENOENT'});
});

test('A pin change after metadata is fenced immediately before the first binary download',async t=>{
    const f=await assetFixture(t),expected={expectedRepository:f.pin.repository,expectedCommit:f.pin.commit,expectedRevision:f.pin.index.sha256};
    await assert.rejects(f.run({ids:[f.tool.id],...expected,onProgress:async()=>f.publish([f.bridge])}),error=>error.code==='ASSET_SOURCE_CHANGED');
    assert.ok(f.calls.every(url=>url.startsWith(f.raw)));await assert.rejects(lstat(f.receipt),{code:'ENOENT'});
});

test('Startup forwards exact IDs/pin, validates the receipt and skips empty intent without launching the CLI',async()=>{
    const calls=[],output={info(){},success(){},warning(){}},choice={ids:['one'],expectedRepository:'example/assets',expectedCommit:'a'.repeat(40),expectedRevision:'b'.repeat(64)},
        report={ok:true,mode:'prefetch',verifyOnly:false,withoutModels:true,revision:choice.expectedRevision,sourceCommit:choice.expectedCommit,selected:['one']};
    const options={root:'/project',environment:{},output,withoutModels:true};
    assert.deepEqual(await prepareStartupAssets(options,async(command,args)=>{calls.push(args);return {status:0,stdout:JSON.stringify(report)};},async()=>choice),report);
    assert.deepEqual(calls[0],['/project/scripts/assets/cli.mjs','--without-models','--asset','one','--expected-repository','example/assets','--expected-commit',choice.expectedCommit,'--expected-revision',choice.expectedRevision]);
    for(const wrong of [{sourceCommit:'c'.repeat(40)},{revision:'d'.repeat(64)},{selected:['other']}])await assert.rejects(prepareStartupAssets(options,async()=>({status:0,stdout:JSON.stringify({...report,...wrong})}),async()=>choice),/Прежние сервисы не остановлены/);
    assert.deepEqual(await prepareStartupAssets(options,async()=>assert.fail('No download for an empty intent'),async()=>({ids:[]})),{ok:false,deferred:true,reason:'assets-skipped'});
});

test('Cold startup imports before the workspace source contract or selection module is installed',async t=>{
    const f=await assetFixture(t),isolated=path.join(f.root,'cold-checkout');
    await mkdir(path.join(isolated,'scripts/assets'),{recursive:true});await mkdir(path.join(isolated,'scripts/models'));
    for(const relative of ['assets/startup.mjs','models/startup-process.mjs'])await copyFile(new URL('../'+relative,import.meta.url),path.join(isolated,'scripts',relative));
    const url=pathToFileURL(path.join(isolated,'scripts/assets/startup.mjs')).href;
    const result=spawnSync(process.execPath,['--input-type=module','-e',`await import(${JSON.stringify(url)})`],{cwd:isolated,encoding:'utf8',timeout:5000});
    assert.equal(result.status,0,result.stderr);assert.equal(result.error,undefined);
});

test('Terminal EOF closes the real readline prompt without hanging or replacing intent',async t=>{
    const f=await assetFixture(t);await saved(f,[f.bridge.id]);const input=new PassThrough();input.isTTY=true;
    const terminalOutput=new Writable({write(chunk,encoding,callback){if(chunk.toString().includes('Выберите ассеты'))setImmediate(()=>input.end());callback();}});terminalOutput.isTTY=true;
    const output={info(){},warning(){}};
    const result=await selectStartupAssets({root:f.root,environment:{},output,withoutModels:true,input,terminalOutput},{request:f.fetch});
    assert.equal(result.skip,true);assert.deepEqual((await previousAssetSelection(f.root)).selected,[f.bridge.id]);
});

test('Linked selection files are rejected without touching their target',async t=>{
    const f=await assetFixture(t);await mkdir(path.join(f.root,'.run'));const target=path.join(f.root,'outside.json');await writeFile(target,'keep');
    await symlink(target,path.join(f.root,'.run/assets-selection.json'));
    await assert.rejects(session(f).choose(),/Небезопасный/);assert.equal(await readFile(target,'utf8'),'keep');assert.deepEqual(f.calls,[]);
});

test('Choice parsing rejects disabled entries, shell text, overflow and unbounded lines',()=>{
    const choices=[{id:'one'},{id:'two',disabled:true}];
    assert.deepEqual(parseAssetSelection('1,1',choices,[]),{ids:['one']});
    for(const text of ['2','-1','1 && rm -rf /','9'.repeat(5000)])assert.throws(()=>parseAssetSelection(text,choices,[]));
});
