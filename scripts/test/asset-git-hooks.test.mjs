import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,writeFile,copyFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {installAssetHooks,uninstallAssetHooks,shouldSyncAfterHook} from '../assets/git-hooks.mjs';
import {updateRepository} from '../assets/update.mjs';
import {assetEnvironment} from '../assets/environment.mjs';

const repo=fileURLToPath(new URL('../../',import.meta.url));
const environment={...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'};
function git(root,args,allowFailure=false,env=environment) {
    const result=spawnSync('git',['-C',root,...args],{env,encoding:'utf8',timeout:30000});
    assert.equal(result.error,undefined);
    if(!allowFailure)assert.equal(result.status,0,result.stderr);
    return result;
}

async function fixture(t) {
    const directory=await mkdtemp(path.join(os.tmpdir(),'neurocenter git assets '));
    t.after(()=>rm(directory,{recursive:true,force:true}));
    const source=path.join(directory,'source'),origin=path.join(directory,'origin.git'),checkout=path.join(directory,'server checkout');
    await mkdir(source);git(source,['init','--initial-branch=main']);
    git(source,['config','user.email','fixture@example.test']);git(source,['config','user.name','Fixture']);
    await mkdir(path.join(source,'scripts/assets'),{recursive:true});await mkdir(path.join(source,'scripts/workspace'));
    for(const file of ['assets/git-hook.mjs','assets/git-hooks.mjs','assets/environment.mjs','assets/cancellation.mjs','workspace/node-runtime.mjs']) {
        await copyFile(path.join(repo,'scripts',file),path.join(source,'scripts',file));
    }
    await mkdir(path.join(source,'scripts/models'));
    await writeFile(path.join(source,'scripts/models/bundle-cli.mjs'),'export const modelBundleProgressReporter=()=>()=>{};\n');
    await writeFile(path.join(source,'scripts/assets/sync.mjs'),`import {appendFile} from 'node:fs/promises';
        import {spawnSync} from 'node:child_process';
        export async function syncAssets({root,environment}) {
            await appendFile(environment.HOOK_TEST_LOG,JSON.stringify({kind:'sync',revision:spawnSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).stdout.trim()})+'\\n');
            if(environment.HOOK_TEST_FAIL==='1')throw new Error('fixture download failed');
            return {ok:true};
        }`);
    await writeFile(path.join(source,'version.txt'),'one\n');
    git(source,['add','.']);git(source,['commit','-m','initial']);
    git(directory,['init','--bare',origin]);git(source,['remote','add','origin',origin]);git(source,['push','origin','main']);
    git(origin,['symbolic-ref','HEAD','refs/heads/main']);git(directory,['clone',origin,checkout]);
    git(checkout,['config','user.email','fixture@example.test']);git(checkout,['config','user.name','Fixture']);
    const log=path.join(directory,'events.jsonl'),env={...environment,HOOK_TEST_LOG:log,NODE_BIN:process.execPath};
    const events=async()=>readFile(log,'utf8').then(value=>value.trim().split('\n').filter(Boolean).map(JSON.parse),error=>{if(error.code==='ENOENT')return [];throw error;});
    const advance=async()=>{await writeFile(path.join(source,'remote.txt'),'two\n');git(source,['add','.']);git(source,['commit','-m','next']);git(source,['push','origin','main']);};
    return {directory,source,checkout,log,env,events,advance};
}

test('Обычный pull получает код и готовит поставку; повторная установка хуков не создаёт рекурсию',async t=>{
    const f=await fixture(t);
    const previous=path.join(f.checkout,'.git/hooks/post-merge');
    await writeFile(previous,'#!/bin/sh\nprintf \'{"kind":"previous","flag":"%s"}\\n\' "$1" >> "$HOOK_TEST_LOG"\n',{mode:0o700});
    await installAssetHooks({root:f.checkout});await installAssetHooks({root:f.checkout});
    await f.advance();git(f.checkout,['pull','--ff-only'],false,f.env);
    const events=await f.events();assert.equal(events.filter(event=>event.kind==='previous').length,1);
    assert.equal(events.filter(event=>event.kind==='sync').length,1);
    assert.equal(events.at(-1).revision,git(f.checkout,['rev-parse','HEAD']).stdout.trim());
    git(f.checkout,['pull','--ff-only'],false,f.env);
    assert.equal((await f.events()).filter(event=>event.kind==='sync').length,1);
});

test('Pull с rebase тоже подготавливает конечную ревизию',async t=>{
    const f=await fixture(t);await installAssetHooks({root:f.checkout});
    await writeFile(path.join(f.checkout,'local.txt'),'local\n');git(f.checkout,['add','.'],false,f.env);
    git(f.checkout,['commit','-m','local'],false,f.env);await f.advance();
    git(f.checkout,['pull','--rebase'],false,f.env);
    const events=(await f.events()).filter(event=>event.kind==='sync');assert.ok(events.length>=1);
    assert.equal(events.at(-1).revision,git(f.checkout,['rev-parse','HEAD']).stdout.trim());
});

test('Отказ загрузки виден после pull и не объявляет готовность поставки',async t=>{
    const f=await fixture(t);await installAssetHooks({root:f.checkout});await f.advance();
    const result=git(f.checkout,['pull','--ff-only'],true,{...f.env,HOOK_TEST_FAIL:'1'});
    assert.match(result.stderr,/Код Git обновлён, но поставка не готова/);
    assert.match(result.stderr,/npm run assets:sync/);
    assert.equal(git(f.checkout,['rev-parse','HEAD']).stdout,git(f.source,['rev-parse','HEAD']).stdout);
});

test('Прежние pre-commit и custom hooksPath сохраняются и восстанавливаются',async t=>{
    const f=await fixture(t),custom=path.join(f.checkout,'.git/own hooks');await mkdir(custom);
    await writeFile(path.join(custom,'pre-commit'),'#!/bin/sh\nprintf "old precommit\\n" >&2\nexit 7\n',{mode:0o700});
    git(f.checkout,['config','--local','core.hooksPath',custom]);await installAssetHooks({root:f.checkout});
    await writeFile(path.join(f.checkout,'version.txt'),'edited\n');git(f.checkout,['add','.'],false,f.env);
    const result=git(f.checkout,['commit','-m','blocked'],true,f.env);
    assert.notEqual(result.status,0);assert.match(result.stderr,/old precommit/);assert.deepEqual(await f.events(),[]);
    await uninstallAssetHooks({root:f.checkout});assert.equal(git(f.checkout,['config','--local','--get','core.hooksPath']).stdout.trim(),custom);
});

test('После удаления своих хуков восстанавливается отсутствие local hooksPath',async t=>{
    const f=await fixture(t);await installAssetHooks({root:f.checkout});await uninstallAssetHooks({root:f.checkout});
    assert.equal(git(f.checkout,['config','--local','--get','core.hooksPath'],true).status,1);
});

test('Отключённые прежние хуки через /dev/null не блокируют подготовку',async t=>{
    const f=await fixture(t);git(f.checkout,['config','--local','core.hooksPath','/dev/null']);
    await installAssetHooks({root:f.checkout});await f.advance();git(f.checkout,['pull','--ff-only'],false,f.env);
    assert.equal((await f.events()).filter(event=>event.kind==='sync').length,1);
    await uninstallAssetHooks({root:f.checkout});assert.equal(git(f.checkout,['config','--local','--get','core.hooksPath']).stdout.trim(),'/dev/null');
});

test('Linked worktree читает общую регистрацию и сохраняет прежний post-checkout',async t=>{
    const f=await fixture(t),linked=path.join(f.directory,'linked');
    await writeFile(path.join(f.checkout,'.git/hooks/post-checkout'),'#!/bin/sh\nprintf \'{"kind":"previous-checkout"}\\n\' >> "$HOOK_TEST_LOG"\n',{mode:0o700});
    await installAssetHooks({root:f.checkout});
    git(f.checkout,['worktree','add','-b','linked',linked],false,f.env);
    const events=await f.events();assert.equal(events.filter(event=>event.kind==='previous-checkout').length,1);
    assert.equal(events.filter(event=>event.kind==='sync').length,1);
    await uninstallAssetHooks({root:linked});assert.equal(git(f.checkout,['config','--local','--get','core.hooksPath'],true).status,1);
});

test('Старая ветка без загрузчика сохраняет прежний хук и показывает границу подготовки',async t=>{
    const f=await fixture(t);
    git(f.checkout,['switch','-c','legacy']);await rm(path.join(f.checkout,'scripts/assets/git-hook.mjs'));
    git(f.checkout,['add','.']);git(f.checkout,['commit','-m','legacy without loader']);git(f.checkout,['switch','main']);
    await writeFile(path.join(f.checkout,'.git/hooks/post-checkout'),'#!/bin/sh\nprintf \'{"kind":"previous-legacy"}\\n\' >> "$HOOK_TEST_LOG"\n',{mode:0o700});
    await installAssetHooks({root:f.checkout});const result=git(f.checkout,['switch','legacy'],false,f.env);
    assert.match(result.stderr,/В этой версии нет загрузчика/);
    assert.equal((await f.events()).filter(event=>event.kind==='previous-legacy').length,1);
});

test('Checkout файла и amend не запускают тяжёлую подготовку',()=>{
    assert.equal(shouldSyncAfterHook('post-checkout',['old','new','0']),false);
    assert.equal(shouldSyncAfterHook('post-checkout',['old','new','1']),true);
    assert.equal(shouldSyncAfterHook('post-rewrite',['amend']),false);
    assert.equal(shouldSyncAfterHook('post-rewrite',['rebase']),true);
});

test('Строгое обновление проверяет поставку после pull без новых коммитов и вызывает новый CLI',()=>{
    const calls=[];
    updateRepository({directory:'/repo',environment:{NODE_BIN:'/node24'},run:(command,args,options)=>{
        calls.push({command,args,options});return {status:0,stdout:''};
    }});
    assert.deepEqual(calls.map(call=>call.args),[['status','--porcelain','--untracked-files=no'],['pull','--ff-only'],['/repo/scripts/assets/cli.mjs']]);
    assert.equal(calls[1].options.env.NEUROCENTER_ASSETS_SKIP_HOOK,'1');
    assert.equal(calls[2].options.env.NEUROCENTER_ASSETS_SKIP_HOOK,undefined);
});

test('Незавершённая поставка и локальные изменения дают ненулевой результат строгого обновления',()=>{
    const calls=[];
    assert.throws(()=>updateRepository({directory:'/repo',run:(command,args)=>{
        calls.push(args);return {status:0,stdout:' M tracked.txt\n'};
    }}),/локальные изменения/);
    assert.equal(calls.length,1);
    assert.throws(()=>updateRepository({directory:'/repo',run:command=>({status:command==='git'?0:7,stdout:''})}),/не завершено/);
});

test('Настройки доставки учитывают файлы окружения и явные значения процесса',async t=>{
    const directory=await mkdtemp(path.join(os.tmpdir(),'neurocenter assets env '));t.after(()=>rm(directory,{recursive:true,force:true}));
    await writeFile(path.join(directory,'.env'),'MODEL_STORAGE_PATH=data/one\nRUNTIME_ARTIFACT_DIR=data/artifacts\n');
    await writeFile(path.join(directory,'.env.local'),'MODEL_STORAGE_PATH=data/two\n');
    assert.deepEqual(await assetEnvironment(directory,{MODEL_STORAGE_PATH:'data/three'}),{MODEL_STORAGE_PATH:'data/three',RUNTIME_ARTIFACT_DIR:'data/artifacts'});
});
