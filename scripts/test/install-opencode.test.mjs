import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const script = fileURLToPath(new URL('../../bridge-dist/install_opencode.sh',import.meta.url));
const roots=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});

/** Изолирует установку от домашнего каталога и настоящих настроек пользователя. */
async function fixture(os='Darwin',arch='arm64',binaryName='opencode') {
    const root=await mkdtemp(path.join(tmpdir(),'neurocenter-installer-')); roots.push(root);
    await mkdir(path.join(root,'fake-bin')); await mkdir(path.join(root,'package/bin'),{recursive:true});
    await writeFile(path.join(root,'fake-bin/uname'),'#!/bin/sh\nif [ "$1" = "-s" ]; then echo "$TEST_OS"; else echo "$TEST_ARCH"; fi\n',{mode:0o755});
    await writeFile(path.join(root,'fake-bin/ldd'),'#!/bin/sh\necho "${TEST_LIBC:-glibc}"\nexit "${TEST_LDD_STATUS:-0}"\n',{mode:0o755});
    await writeFile(path.join(root,'package/bin',binaryName),'#!/usr/bin/env bash\necho "1.14.48"\n',{mode:0o755});
    const archive=path.join(root,'fixture.tgz');
    execFileSync('tar',['-czf',archive,'-C',root,'package']);
    const env={...process.env,PATH:path.join(root,'fake-bin')+path.delimiter+process.env.PATH,TEST_OS:os,TEST_ARCH:arch,OPENCODE_NO_PROMPT:'1',OPENCODE_INSTALL_DIR:path.join(root,'install'),OPENCODE_CONFIG_DIR:path.join(root,'config'),OPENCODE_AUTH_DIR:path.join(root,'auth'),OPENCODE_PROFILE:path.join(root,'profile'),SHELL:'/bin/zsh'};
    const run=(args=['--binary',archive], overrides={})=>spawnSync('bash',[script,...args],{env:{...env,...overrides},encoding:'utf8'});
    return {root,archive,env,run};
}

for(const [os,arch,binary] of [['Darwin','arm64','opencode'],['Darwin','x86_64','opencode'],['Linux','x86_64','opencode'],['Linux','aarch64','opencode'],['MINGW64_NT-10.0','x86_64','opencode.exe'],['MSYS_NT-10.0','aarch64','opencode.exe']]) {
    test(`Установка для ${os} / ${arch} сохраняет существующие настройки`, async()=>{
        const f=await fixture(os,arch,binary);
        await mkdir(f.env.OPENCODE_CONFIG_DIR); await mkdir(f.env.OPENCODE_AUTH_DIR);
        const config='// Настройки пользователя\n{"mcp":{"existing":{"enabled":true}}}';
        const auth='{"another-provider":{"type":"api","key":"existing"}}';
        await writeFile(path.join(f.env.OPENCODE_CONFIG_DIR,'opencode.jsonc'),config);
        await writeFile(path.join(f.env.OPENCODE_AUTH_DIR,'auth.json'),auth);
        const result=f.run(); assert.equal(result.status,0,result.stderr);
        assert.equal(await readFile(path.join(f.env.OPENCODE_CONFIG_DIR,'opencode.jsonc'),'utf8'),config);
        assert.equal(await readFile(path.join(f.env.OPENCODE_AUTH_DIR,'auth.json'),'utf8'),auth);
        assert.equal(execFileSync(path.join(f.env.OPENCODE_INSTALL_DIR,binary),['--version'],{encoding:'utf8'}).trim(),'1.14.48');
    });
}

test('Переданный ключ не сохраняется и не печатается до выбора провайдера',async()=>{
    const f=await fixture(); const key='sk-example"\\key';
    const result=f.run(undefined,{OPENCODE_API_KEY:key}); assert.equal(result.status,0,result.stderr);
    await assert.rejects(readFile(path.join(f.env.OPENCODE_AUTH_DIR,'auth.json')),{code:'ENOENT'});
    assert.deepEqual(JSON.parse(await readFile(path.join(f.env.OPENCODE_CONFIG_DIR,'opencode.jsonc'),'utf8')),{
        $schema:'https://opencode.ai/config.json'
    });
    assert.ok(!result.stdout.includes(key)); assert.ok(!result.stderr.includes(key));
    assert.ok(result.stdout.includes('OPENCODE_API_KEY не сохранён: выберите провайдера через opencode auth login.'));
    assert.ok(result.stdout.includes('Провайдер и модель установщиком не настраиваются.'));
});

test('Переданный ключ не заменяет существующую авторизацию',async()=>{
    const f=await fixture(); const key='sk-replacement"\\key';
    await mkdir(f.env.OPENCODE_AUTH_DIR);
    const auth='{"another-provider":{"type":"api","key":"existing-fixture-key"}}';
    await writeFile(path.join(f.env.OPENCODE_AUTH_DIR,'auth.json'),auth);
    const result=f.run(undefined,{OPENCODE_API_KEY:key}); assert.equal(result.status,0,result.stderr);
    assert.equal(await readFile(path.join(f.env.OPENCODE_AUTH_DIR,'auth.json'),'utf8'),auth);
    for(const secret of [key,'existing-fixture-key']) {
        assert.ok(!result.stdout.includes(secret)); assert.ok(!result.stderr.includes(secret));
    }
    assert.ok(result.stdout.includes('Существующие ключи авторизации сохранены. Для смены ключа: opencode auth login'));
    assert.ok(result.stdout.includes('OPENCODE_API_KEY не сохранён: выберите провайдера через opencode auth login.'));
});

test('Повторный запуск не дублирует PATH и учитывает существующий opencode.json',async()=>{
    const f=await fixture(); await mkdir(f.env.OPENCODE_CONFIG_DIR);
    await writeFile(path.join(f.env.OPENCODE_CONFIG_DIR,'opencode.json'),'{}');
    assert.equal(f.run().status,0); assert.equal(f.run().status,0);
    const profile=await readFile(f.env.OPENCODE_PROFILE,'utf8');
    assert.equal(profile.split('export PATH=').length-1,1);
    await assert.rejects(readFile(path.join(f.env.OPENCODE_CONFIG_DIR,'opencode.jsonc')),{code:'ENOENT'});
});

test('Ошибочный бинарник не заменяет работающую установку',async()=>{
    const f=await fixture(); await mkdir(f.env.OPENCODE_INSTALL_DIR);
    const old=path.join(f.env.OPENCODE_INSTALL_DIR,'opencode'); await writeFile(old,'previous',{mode:0o755});
    await writeFile(path.join(f.root,'package/bin/opencode'),'#!/bin/sh\nexit 1\n');
    execFileSync('tar',['-czf',f.archive,'-C',f.root,'package']);
    assert.notEqual(f.run().status,0); assert.equal(await readFile(old,'utf8'),'previous');
});

test('Архив со ссылкой отклоняется до записи настроек',async()=>{
    const f=await fixture(); await symlink('/tmp',path.join(f.root,'package/link'));
    execFileSync('tar',['-czf',f.archive,'-C',f.root,'package']);
    assert.notEqual(f.run().status,0);
    await assert.rejects(readFile(path.join(f.env.OPENCODE_CONFIG_DIR,'opencode.jsonc')),{code:'ENOENT'});
});

for(const [os,arch,libc,variant] of [
    ['Darwin','arm64','','darwin-arm64'],
    ['Darwin','x86_64','','darwin-x64-baseline'],
    ['Linux','aarch64','glibc','linux-arm64'],
    ['Linux','aarch64','musl','linux-arm64-musl'],
    ['Linux','x86_64','glibc','linux-x64-baseline'],
    ['Linux','x86_64','musl','linux-x64-baseline-musl'],
    ['MINGW64_NT','aarch64','','windows-arm64'],
    ['MINGW64_NT','x86_64','','windows-x64-baseline'],
]) {
    test(`Загрузка с площадки выбирает архив ${variant}`,async()=>{
        const f=await fixture(os,arch,os.startsWith('MINGW')?'opencode.exe':'opencode');
        await writeFile(path.join(f.root,'fake-bin/curl'),'#!/bin/sh\nprintf "%s\\n" "$*" >> "$TEST_ROOT/urls"\ncase "$2" in *.sha256) shasum -a 256 "$TEST_ROOT/fixture.tgz" | cut -d " " -f1 > "$4" ;; *) cp "$TEST_ROOT/fixture.tgz" "$4" ;; esac\n',{mode:0o755});
        const result=f.run([],{TEST_ROOT:f.root,TEST_LIBC:libc,TEST_LDD_STATUS:libc==='musl'?'1':'0',BASE_URL:'http://localhost:5173/api/bridge'});
        assert.equal(result.status,0,result.stderr);
        const urls=await readFile(path.join(f.root,'urls'),'utf8');
        assert.ok(urls.includes(`/opencode/opencode-${variant}-1.14.48.tgz`));
        assert.ok(!urls.includes('npmjs.org'));
    });
}
