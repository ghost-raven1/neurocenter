import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync,spawn} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {buildPackages,sourceSnapshot,exclusion,artifactTree} from '../workspace/isolated-build-source.mjs';
import {isolatedBuild,isolatedBuildPlan,parseBuildArguments,main} from '../workspace/isolated-build.mjs';

const catalog=buildPackages.filter(([id])=>id==='catalog-service');
const scriptRoot=fileURLToPath(new URL('../../',import.meta.url));
const basicCompiler=`import fs from 'node:fs';import path from 'node:path';
const cwd=process.cwd(),name=path.basename(cwd),entry=name==='frontend'?'index.html':name==='neurocenter-asset-sync'?'index.js':'main.js';
fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/'+entry,JSON.stringify({input:fs.existsSync('input.txt')?fs.readFileSync('input.txt','utf8'):null,newFile:fs.existsSync('new.txt')?fs.readFileSync('new.txt','utf8'):null,deleted:fs.existsSync('deleted.txt'),dotenv:fs.existsSync('.env'),template:fs.existsSync('.env.example'),npmrc:fs.existsSync('.npmrc'),env:process.env,args:process.argv.slice(2)}));`;

async function waitFor(read,timeout=5000){const started=Date.now();while(Date.now()-started<timeout){const value=await read();if(value)return value;await delay(20);}throw Error('Owned fixture readiness deadline exceeded.');}
const readJson=async file=>{try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(error){if(error.code==='ENOENT'||error instanceof SyntaxError)return null;throw error;}};

async function fixture(t,compiler=basicCompiler){
    const parent=await fs.realpath(await fs.mkdtemp(path.join(tmpdir(),'neurocenter isolated build '))),root=path.join(parent,'checkout with spaces');
    await fs.mkdir(root);t.after(()=>fs.rm(parent,{recursive:true,force:true}));
    await fs.writeFile(path.join(root,'package.json'),JSON.stringify({name:'neurocenter-workspace'}));
    await fs.writeFile(path.join(root,'.gitignore'),'.run/\nnode_modules/\ndist/\n*.log\n');
    await fs.writeFile(path.join(root,'compiler.mjs'),compiler);await fs.mkdir(path.join(root,'node_modules'));
    for(const [id,folder]of buildPackages){await fs.mkdir(path.join(root,folder,'node_modules'),{recursive:true});const prefix=id==='frontend'?'../':'../../';
        await fs.writeFile(path.join(root,folder,'package.json'),JSON.stringify({name:id,version:'1.0.0',scripts:{build:'node '+prefix+'compiler.mjs',install:'node -e "process.exit(41)"'}}));}
    const directory=path.join(root,'services/catalog-service');await fs.writeFile(path.join(directory,'input.txt'),'old-input');await fs.writeFile(path.join(directory,'deleted.txt'),'old-deleted');
    const git=args=>execFileSync('/usr/bin/git',['-c','core.hooksPath=/dev/null',...args],{cwd:root,encoding:'utf8',env:{PATH:'/usr/bin:/bin',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'}}).trim();
    git(['init','-q','-b','main']);git(['add','.']);git(['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-qm','fixture']);
    for(const [,folder,entry]of buildPackages){await fs.mkdir(path.join(root,folder,'dist'));await fs.writeFile(path.join(root,folder,'dist',entry),'OLD_LIVE_DIST');}
    return {parent,root,directory,git};
}
const outputOf=async result=>JSON.parse(await fs.readFile(path.join(result.repository,'services/catalog-service/dist/main.js'),'utf8'));
async function evidence(label,result){
    if(!process.env.NEUROCENTER_ISOLATED_BUILD_EVIDENCE)return;
    const folder=path.resolve(process.env.NEUROCENTER_ISOLATED_BUILD_EVIDENCE,label);assert.ok(folder.startsWith(path.join(scriptRoot,'.run/')));
    await fs.mkdir(folder,{recursive:true,mode:0o700});const source=path.dirname(result.repository);
    for(const name of await fs.readdir(source))if(/\.(?:json|log)$/.test(name)){const bytes=await fs.readFile(path.join(source,name));assert.ok(bytes.length<2*1024**2);await fs.writeFile(path.join(folder,name),bytes,{mode:0o600});}
}
function startFixtureBuild(t,root,options={}){
    const controller=new AbortController(),signal=options.signal?AbortSignal.any([controller.signal,options.signal]):controller.signal;
    const pending=isolatedBuild(root,catalog,{timeoutMs:5000,...options,signal});pending.catch(()=>{});
    t.after(async()=>{controller.abort();await pending;});return pending;
}

test('help and plan reject arbitrary selection and do not create run directories or launch builds',async t=>{
    const f=await fixture(t);let output='';const stream={write:value=>{output+=value;}};
    assert.equal(await main(['--help'],{root:f.root,output:stream}),0);assert.match(output,/--package/);
    assert.equal(await main(['--plan','--package','catalog-service'],{root:f.root,output:stream}),0);
    await assert.rejects(fs.stat(path.join(f.root,'.run')),error=>error.code==='ENOENT');
    assert.equal(parseBuildArguments(['--all']).selection.length,8);
    for(const args of [[],['--package','../../private'],['--all','--package','bridge'],['--package'],['--all','--install'],['--help','--all']])assert.throws(()=>parseBuildArguments(args),error=>error.code==='INVALID_ARGUMENT');
    await assert.rejects(isolatedBuildPlan(f.root,[['catalog-service','../private','main.js']]),error=>error.code==='INVALID_ARGUMENT');
    const actual=execFileSync(process.execPath,[path.join(scriptRoot,'scripts/workspace/isolated-build.mjs'),'--help'],{encoding:'utf8'});assert.match(actual,/Node24/);
});

test('the real default CLI plans all8 packages from an unrelated cwd using its canonical module-root path',async t=>{
    const f=await fixture(t),output=execFileSync(process.execPath,[path.join(scriptRoot,'scripts/workspace/isolated-build.mjs'),'--all','--plan'],
        {cwd:f.parent,encoding:'utf8',env:{PATH:path.dirname(process.execPath)+':/usr/bin:/bin',HOME:f.parent,XDG_CONFIG_HOME:f.parent}});
    const plan=JSON.parse(output);assert.equal(plan.mode,'plan');assert.deepEqual(plan.packages.map(item=>item.id),buildPackages.map(([id])=>id));
    assert.equal(plan.requiresNode,24);await assert.rejects(fs.stat(path.join(f.parent,'.run')),error=>error.code==='ENOENT');
});

test('actual npm builds dirty and new inputs, respects deletion, excludes active config and preserves all old live outputs',async t=>{
    const f=await fixture(t);await fs.writeFile(path.join(f.directory,'input.txt'),'CURRENT_DIRTY_INPUT');await fs.writeFile(path.join(f.directory,'new.txt'),'CURRENT_NEW_INPUT');await fs.rm(path.join(f.directory,'deleted.txt'));
    await fs.writeFile(path.join(f.directory,'.env'),'SECRET_DOTENV');await fs.writeFile(path.join(f.directory,'.env.example'),'SAFE_TEMPLATE');await fs.writeFile(path.join(f.directory,'.npmrc'),'//registry.example/:_authToken=SECRET_NPMRC');
    const previous=process.env.NPM_TOKEN;process.env.NPM_TOKEN='CALLER_SECRET';t.after(()=>{if(previous===undefined)delete process.env.NPM_TOKEN;else process.env.NPM_TOKEN=previous;});
    const result=await isolatedBuild(f.root,catalog);assert.equal(result.ok,true);assert.equal(result.sourceCurrent,true);assert.equal(result.liveOutputsUnchanged,true);assert.equal(result.dependencyLinksUnchanged,true);
    const output=await outputOf(result);assert.equal(output.input,'CURRENT_DIRTY_INPUT');assert.equal(output.newFile,'CURRENT_NEW_INPUT');assert.equal(output.deleted,false);assert.equal(output.dotenv,false);assert.equal(output.npmrc,false);assert.equal(output.template,true);
    assert.equal(output.env.NPM_TOKEN,undefined);assert.equal(output.env.npm_config_offline,'true');assert.ok(output.env.HOME.startsWith(path.dirname(result.repository)));assert.equal(result.inputs.deleted,1);assert.ok(result.inputs.newFiles>=2);
    const source=await readJson(path.join(path.dirname(result.repository),'source-before.json'));assert.equal(source.records['services/catalog-service/deleted.txt'].state,'deleted');assert.equal(source.records['services/catalog-service/new.txt'].tracked,false);
    assert.match(source.excluded['services/catalog-service/.env'],/sensitive/);assert.ok(result.builds[0].command.includes('build'));assert.ok(!result.builds[0].command.includes('ci'));
    for(const [,folder,entry]of buildPackages)assert.equal(await fs.readFile(path.join(f.root,folder,'dist',entry),'utf8'),'OLD_LIVE_DIST');
    assert.equal((await fs.stat(path.dirname(result.repository))).mode&0o777,0o700);
    await evidence('dirty-new-deleted',result);
});

test('all selection builds eight tiny owned fixture packages sequentially and records frontend runner adaptation',async t=>{
    const f=await fixture(t);const result=await isolatedBuild(f.root,buildPackages);assert.equal(result.ok,true);assert.equal(result.builds.length,8);assert.deepEqual(result.builds.map(item=>item.id),buildPackages.map(([id])=>id));
    assert.deepEqual(result.builds[0].command.slice(-3),['--','--configLoader','runner']);assert.ok(result.builds.every(item=>item.artifacts.requiredEntryPresent&&item.leaderReaped&&item.cleanup.noLiveDescendants));
});

test('changes during copy reject before npm and retain the original failure receipt',async t=>{
    const f=await fixture(t);let changed=false;
    const result=await isolatedBuild(f.root,catalog,{onCopied:async name=>{if(!changed&&name==='compiler.mjs'){changed=true;await fs.writeFile(path.join(f.directory,'input.txt'),'CHANGED_DURING_COPY');}}});
    assert.equal(result.ok,false);assert.equal(result.primaryFailure.code,'SOURCE_CHANGED');assert.equal(result.builds.length,0);assert.equal((await readJson(result.receipt)).primaryFailure.code,'SOURCE_CHANGED');
    await evidence('changed-during-copy',result);
});

test('source links and private output ancestors are rejected without reading or modifying outside sentinels',async t=>{
    const f=await fixture(t),sentinel=path.join(f.parent,'outside-private');await fs.writeFile(sentinel,'PRIVATE_SENTINEL');await fs.symlink(sentinel,path.join(f.root,'linked-source.txt'));
    const result=await isolatedBuild(f.root,catalog);assert.equal(result.ok,false);assert.equal(result.primaryFailure.code,'UNSAFE_SOURCE');assert.equal(result.builds.length,0);assert.equal(await fs.readFile(sentinel,'utf8'),'PRIVATE_SENTINEL');
    await fs.rm(path.join(f.root,'linked-source.txt'));await fs.rm(path.join(f.root,'.run'),{recursive:true});await fs.symlink(f.parent,path.join(f.root,'.run'));
    await assert.rejects(isolatedBuild(f.root,catalog),error=>error.code==='UNSAFE_OUTPUT');assert.equal(await fs.readFile(sentinel,'utf8'),'PRIVATE_SENTINEL');
});

test('path and sparse input bounds fail before reading oversized retained bytes',async t=>{
    const f=await fixture(t);for(const name of ['../private','/tmp/private','a\\b','a\nname','x/'.repeat(600)])assert.throws(()=>exclusion(name),error=>error.code==='UNSAFE_SOURCE');
    const file=await fs.open(path.join(f.root,'oversized.bin'),'w');await file.truncate(64*1024**2+1);await file.close();
    await assert.rejects(sourceSnapshot(f.root),error=>error.code==='INPUT_LIMIT');
});

test('credential implementation modules remain source inputs while private configuration stays excluded',async t=>{
    const f=await fixture(t,"import {marker} from './credential.mjs';"+basicCompiler+"if(marker!=='SOURCE_MODULE')process.exit(12);");
    await fs.writeFile(path.join(f.root,'credential.mjs'),"export const marker='SOURCE_MODULE';");
    const result=await isolatedBuild(f.root,catalog);assert.equal(result.ok,true);assert.equal(exclusion('mcp/neurocenter-asset-sync/src/features/opencode-providers/credential.ts'),null);
    assert.equal(exclusion('secrets/private.json'),'sensitive-or-active-configuration');assert.equal(exclusion('credentials.json'),'sensitive-or-active-configuration');
});

test('compiler failure and missing entry cannot reuse a previous live dist or appear successful',async t=>{
    const failed=await fixture(t,"console.error('EXPECTED_COMPILER_FAILURE');process.exit(7);");const result=await isolatedBuild(failed.root,catalog);
    assert.equal(result.ok,false);assert.equal(result.primaryFailure.code,'BUILD_FAILED');assert.notEqual(result.builds[0].exitCode,0);assert.equal(result.builds[0].artifacts.requiredEntryPresent,false);assert.equal(result.liveOutputsUnchanged,true);
    assert.match(await fs.readFile(path.join(failed.root,result.builds[0].log.path),'utf8'),/EXPECTED_COMPILER_FAILURE/);
    await evidence('compiler-failure',result);
    const missing=await fixture(t,"import fs from 'node:fs';fs.mkdirSync('dist');fs.writeFileSync('dist/wrong.js','wrong');");const second=await isolatedBuild(missing.root,catalog);
    assert.equal(second.ok,false);assert.equal(second.primaryFailure.code,'MISSING_ENTRY');assert.equal(second.builds[0].exitCode,0);assert.equal(second.liveOutputsUnchanged,true);
});

test('a log observation failure cannot replace the primary compiler failure or lose its receipt entry',async t=>{
    const f=await fixture(t,"import fs from 'node:fs';import path from 'node:path';fs.unlinkSync(path.join(path.dirname(process.env.HOME),'catalog-service.log'));process.exit(7);");
    const result=await isolatedBuild(f.root,catalog);assert.equal(result.ok,false);assert.equal(result.primaryFailure.code,'BUILD_FAILED');assert.equal(result.builds[0].exitCode,7);
    assert.equal(result.builds[0].log.error.code,'LOG_READ_FAILED');assert.equal((await readJson(result.receipt)).primaryFailure.code,'BUILD_FAILED');
    await evidence('primary-versus-log-observer',result);
});

test('a linked candidate entry cannot expose outside bytes or masquerade as a compiled artifact',async t=>{
    const f=await fixture(t),outside=path.join(f.parent,'outside-artifact-private');await fs.writeFile(outside,'DO_NOT_READ_ARTIFACT_SECRET');
    await fs.writeFile(path.join(f.root,'compiler.mjs'),"import fs from 'node:fs';fs.mkdirSync('dist');fs.symlinkSync("+JSON.stringify(outside)+",'dist/main.js');");
    const result=await isolatedBuild(f.root,catalog);assert.equal(result.ok,false);assert.equal(result.primaryFailure.code,'UNSAFE_SOURCE');assert.equal(result.liveOutputsUnchanged,true);
    assert.equal(await fs.readFile(outside,'utf8'),'DO_NOT_READ_ARTIFACT_SECRET');assert.ok(!JSON.stringify(result).includes('DO_NOT_READ_ARTIFACT_SECRET'));
});

const waitingCompiler=basicCompiler+`\nimport {setTimeout as delay} from 'node:timers/promises';fs.mkdirSync('.run',{recursive:true});fs.writeFileSync('.run/entered','ready');while(!fs.existsSync('.run/release'))await delay(10);`;
async function enteredCandidate(root){return waitFor(async()=>{let entries;try{entries=await fs.readdir(path.join(root,'.run/isolated-build'));}catch(error){if(error.code==='ENOENT')return;throw error;}
    for(const id of entries){const candidate=path.join(root,'.run/isolated-build',id,'repository/services/catalog-service');try{await fs.stat(path.join(candidate,'.run/entered'));return candidate;}catch(error){if(error.code!=='ENOENT')throw error;}}});}

test('source edits after launch retain old candidate hashes but do not claim the current checkout passed',async t=>{
    const f=await fixture(t,waitingCompiler),pending=startFixtureBuild(t,f.root),candidate=await enteredCandidate(f.root);
    await fs.writeFile(path.join(f.directory,'input.txt'),'EDITED_AFTER_LAUNCH');await fs.writeFile(path.join(candidate,'.run/release'),'go');const result=await pending;
    assert.equal(result.builds[0].ok,true);assert.equal(result.ok,false);assert.equal(result.sourceCurrent,false);assert.equal(result.primaryFailure.code,'SOURCE_CHANGED_AFTER_SNAPSHOT');assert.equal((await outputOf(result)).input,'old-input');
    await evidence('changed-after-launch',result);
});

test('dependency link replacement is detected independently of unchanged source bytes',async t=>{
    const f=await fixture(t,waitingCompiler),pending=startFixtureBuild(t,f.root),candidate=await enteredCandidate(f.root);
    await fs.rename(path.join(f.directory,'node_modules'),path.join(f.directory,'old-node_modules'));await fs.mkdir(path.join(f.directory,'node_modules'));await fs.writeFile(path.join(candidate,'.run/release'),'go');const result=await pending;
    assert.equal(result.ok,false);assert.equal(result.dependencyLinksUnchanged,false);assert.equal(result.primaryFailure.code,'DEPENDENCIES_CHANGED');
});

const writerSource=`import fs from 'node:fs';process.on('SIGTERM',()=>{});fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/writer-ready.json',JSON.stringify({pid:process.pid}));setInterval(()=>fs.appendFileSync('dist/heartbeat','beat\\n'),10);`;
function writerCompiler(orphan=false,exitCode=0){return basicCompiler+`\nimport {spawn} from 'node:child_process';import {setTimeout as delay} from 'node:timers/promises';
const writer=spawn(process.execPath,['../../writer.mjs'],{stdio:'ignore',detached:false});while(!fs.existsSync('dist/writer-ready.json'))await delay(10);${orphan?'writer.unref();process.exit('+exitCode+');':'await new Promise(()=>{});'}`;}
async function writerReady(root){return waitFor(async()=>{let entries;try{entries=await fs.readdir(path.join(root,'.run/isolated-build'));}catch(error){if(error.code==='ENOENT')return;throw error;}
    for(const id of entries){const value=await readJson(path.join(root,'.run/isolated-build',id,'repository/services/catalog-service/dist/writer-ready.json'));if(value)return value;}return null;});}
function state(pid){try{return execFileSync('/bin/ps',['-p',String(pid),'-o','stat='],{encoding:'utf8'}).trim();}catch{return '';}}

test('cancellation kills actual npm/compiler/writer group while a separate owned sentinel remains alive',async t=>{
    const f=await fixture(t,writerCompiler()),controller=new AbortController();await fs.writeFile(path.join(f.root,'writer.mjs'),writerSource);
    const sentinel=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true});const exited=once(sentinel,'exit');t.after(async()=>{sentinel.kill('SIGTERM');await exited;});
    const sentinelIdentity=execFileSync('/bin/ps',['-p',String(sentinel.pid),'-o','lstart='],{encoding:'utf8'});
    const pending=startFixtureBuild(t,f.root,{signal:controller.signal,graceMs:80}),writer=await writerReady(f.root);controller.abort();const result=await pending;
    assert.equal(result.ok,false);assert.equal(result.primaryFailure.code,'CANCELLED');assert.equal(result.builds[0].leaderReaped,true);assert.equal(result.builds[0].cleanup.noLiveDescendants,true);assert.ok(result.builds[0].cleanup.signals.includes('SIGKILL'));
    assert.ok(!state(writer.pid)||state(writer.pid).startsWith('Z'));assert.equal(execFileSync('/bin/ps',['-p',String(sentinel.pid),'-o','lstart='],{encoding:'utf8'}),sentinelIdentity);assert.equal(result.liveOutputsUnchanged,true);
    await evidence('cancelled-writer',result);
});

test('early npm success with an owned surviving writer is cleaned and rejected; compiler failure remains primary',async t=>{
    for(const exitCode of[0,7]){const f=await fixture(t,writerCompiler(true,exitCode));await fs.writeFile(path.join(f.root,'writer.mjs'),writerSource);
        const result=await isolatedBuild(f.root,catalog,{graceMs:80});assert.equal(result.ok,false);assert.equal(result.primaryFailure.code,exitCode===0?'SURVIVING_DESCENDANTS':'BUILD_FAILED');
        assert.equal(result.builds[0].cleanup.noLiveDescendants,true);assert.ok(result.builds[0].cleanup.signals.includes('SIGKILL'));assert.equal(result.liveOutputsUnchanged,true);}
});

test('timeout stops owned pending compilation and retains a failed receipt',async t=>{
    const f=await fixture(t,'setInterval(()=>{},1000);');const result=await isolatedBuild(f.root,catalog,{timeoutMs:120,graceMs:80});
    assert.equal(result.ok,false);assert.equal(result.primaryFailure.code,'BUILD_TIMEOUT');assert.equal(result.builds[0].leaderReaped,true);assert.equal(result.builds[0].cleanup.noLiveDescendants,true);assert.ok(await readJson(result.receipt));
});
