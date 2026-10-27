import assert from 'node:assert/strict';
import {afterEach, test} from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';

const template=await fs.readFile(new URL('../../bridge-dist/install_workspace.sh',import.meta.url),'utf8');
const roots=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>fs.rm(root,{recursive:true,force:true})));});

/** Real Bash dispatches harmless child installers; every file belongs to the fixture. */
async function fixture(){
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'nc-workspace-installer-'));roots.push(root);
    for(const directory of ['bin','home','temp','children'])await fs.mkdir(path.join(root,directory));
    const source=template.replaceAll('__BASE_URL__','https://gateway.example.test/api/bridge')
        .replaceAll('__SITE_URL__','https://panel.example.test').replace('__BRIDGE_VERSION__','0.9.23').replace('__RECONNECT__','1');
    const script=path.join(root,'workspace.sh');await fs.writeFile(script,source);
    await fs.writeFile(path.join(root,'bin/curl'),`#!/bin/bash
set -eu
url=''; target=''
while [ "$#" -gt 0 ]; do
  case "$1" in https://*) url="$1"; shift ;; -o) target="$2"; shift 2 ;; *) shift ;; esac
done
printf '%s\\n' "$url" >> "$FIXTURE_ROOT/downloads"
case "$url" in
  */install_opencode.sh) name=opencode ;;
  */install.sh?version=0.9.23\\&reconnect=1) name=bridge ;;
  *) exit 96 ;;
esac
[ "\${FAIL_DOWNLOAD:-}" != "$name" ] || exit 22
[ "\${EMPTY_DOWNLOAD:-}" != "$name" ] || { : > "$target"; exit 0; }
if [ -n "$target" ]; then cp "$FIXTURE_ROOT/children/$name.sh" "$target"; else cat "$FIXTURE_ROOT/children/$name.sh"; fi
`,{mode:0o755});
    await fs.writeFile(path.join(root,'children/opencode.sh'),`#!/bin/bash
printf 'opencode|%s|%s\\n' "$BASE_URL" "$OPENCODE_VERSION" >> "$FIXTURE_ROOT/dispatches"
[ "\${FAIL_OPENCODE:-0}" = 0 ] || exit "$FAIL_OPENCODE"
printf 'opencode installed' > "$HOME/installed-opencode"
`);
    await fs.writeFile(path.join(root,'children/bridge.sh'),`#!/bin/bash
printf 'bridge|%s|%s\\n' "$BASE_URL" "$SITE_URL" >> "$FIXTURE_ROOT/dispatches"
[ -f "$HOME/installed-opencode" ] || exit 97
[ "\${FAIL_BRIDGE:-0}" = 0 ] || exit "$FAIL_BRIDGE"
printf 'bridge installed' > "$HOME/installed-bridge"
`);
    await fs.writeFile(path.join(root,'home/manual-config'),'manual configuration');
    const env={...process.env,HOME:path.join(root,'home'),TMPDIR:path.join(root,'temp'),
        FIXTURE_ROOT:root,PATH:path.join(root,'bin')+path.delimiter+process.env.PATH,
        BASE_URL:'https://untrusted-env.example.test',SITE_URL:'https://other.example.test',OPENCODE_VERSION:'99.0.0'};
    const run=(args=[],overrides={})=>spawnSync('bash',[script,...args],{env:{...env,...overrides},encoding:'utf8',timeout:10000});
    return{root,env,run,read:file=>fs.readFile(path.join(root,file),'utf8')};
}

test('workspace installs OpenCode before bridge, pins origins/version and cleans only its staging',async()=>{
    const f=await fixture(),result=f.run();assert.equal(result.status,0,result.stderr);
    assert.equal(await f.read('dispatches'),'opencode|https://gateway.example.test/api/bridge|1.14.48\nbridge|https://gateway.example.test/api/bridge|https://panel.example.test\n');
    assert.equal(await f.read('downloads'),'https://gateway.example.test/api/bridge/install_opencode.sh\nhttps://gateway.example.test/api/bridge/install.sh?version=0.9.23&reconnect=1\n');
    assert.equal(await f.read('home/manual-config'),'manual configuration');
    assert.equal(await f.read('home/installed-bridge'),'bridge installed');
    assert.deepEqual(await fs.readdir(f.env.TMPDIR),[]);
    assert.match(result.stdout,/https:\/\/panel.example.test\/start/);
    assert.match(result.stdout,/проверяется отдельно/);
});

test('a missing second installer cannot start either installation',async()=>{
    const f=await fixture(),result=f.run([],{FAIL_DOWNLOAD:'bridge'});assert.equal(result.status,1);
    await assert.rejects(f.read('dispatches'),{code:'ENOENT'});
    assert.match(result.stderr,/установка ещё не запускалась/);
    assert.deepEqual(await fs.readdir(f.env.TMPDIR),[]);
});

test('an empty successful HTTP response cannot be accepted as a completed installer',async()=>{
    const f=await fixture(),result=f.run([],{EMPTY_DOWNLOAD:'bridge'});assert.equal(result.status,1);
    await assert.rejects(f.read('dispatches'),{code:'ENOENT'});assert.match(result.stderr,/пустой установщик/);
    assert.deepEqual(await fs.readdir(f.env.TMPDIR),[]);
});

test('OpenCode failure preserves child status, prevents bridge dispatch and retains configuration',async()=>{
    const f=await fixture(),result=f.run([],{FAIL_OPENCODE:'17'});assert.equal(result.status,17);
    assert.equal((await f.read('dispatches')).split('\n').filter(Boolean).length,1);
    assert.match(result.stderr,/кодом 17.*Мост ещё не запускался/);
    assert.equal(await f.read('home/manual-config'),'manual configuration');
    assert.deepEqual(await fs.readdir(f.env.TMPDIR),[]);
});

test('bridge failure retains OpenCode and the printed existing-installer recovery works without OpenCode redispatch',async()=>{
    const f=await fixture(),failed=f.run([],{FAIL_BRIDGE:'23'});assert.equal(failed.status,23);
    assert.equal(await f.read('home/installed-opencode'),'opencode installed');
    assert.match(failed.stderr,/кодом 23/);assert.match(failed.stderr,/\/install\.sh/);assert.doesNotMatch(failed.stderr,/install_workspace\.sh/);
    const recoveryCommand=failed.stderr.split('\n').find(line=>line.startsWith('  curl '));assert.ok(recoveryCommand);
    const recovered=spawnSync('bash',['-c',recoveryCommand],{env:f.env,encoding:'utf8',timeout:10000});assert.equal(recovered.status,0,recovered.stderr);
    const dispatches=await f.read('dispatches');assert.equal(dispatches.match(/^opencode\|/gm).length,1);assert.equal(dispatches.match(/^bridge\|/gm).length,2);
    assert.equal(await f.read('home/installed-bridge'),'bridge installed');
    assert.deepEqual(await fs.readdir(f.env.TMPDIR),[]);
});

test('the downloaded wrapper also supports an explicit bridge-only continuation',async()=>{
    const f=await fixture();await fs.writeFile(path.join(f.env.HOME,'installed-opencode'),'existing OpenCode');
    const result=f.run(['--bridge-only']);assert.equal(result.status,0,result.stderr);
    assert.doesNotMatch(await f.read('downloads'),/install_opencode/);assert.doesNotMatch(await f.read('dispatches'),/^opencode\|/m);
    assert.equal(await f.read('home/installed-opencode'),'existing OpenCode');
});

test('unknown options and unresolved or unsafe origins stop before download or child dispatch',async()=>{
    const f=await fixture();assert.equal(f.run(['--unknown']).status,1);assert.equal(f.run(['--help']).status,0);
    for(const replacement of ['__BASE_URL__','https://user:secret@example.test/api/bridge','https://example.test/api/bridge?key=secret']){
        const source=template.replace('__BASE_URL__',replacement).replace('__SITE_URL__','https://panel.example.test')
            .replace('__BRIDGE_VERSION__','0.9.23').replace('__RECONNECT__','0');
        await fs.writeFile(path.join(f.root,'workspace.sh'),source);assert.equal(f.run().status,1);
    }
    await assert.rejects(f.read('downloads'),{code:'ENOENT'});await assert.rejects(f.read('dispatches'),{code:'ENOENT'});
});

test('PowerShell wrapper keeps native child status checks and restores temporary environment (source contract, not Windows execution)',async()=>{
    const source=await fs.readFile(new URL('../../bridge-dist/install_workspace.ps1',import.meta.url),'utf8');
    assert.match(source,/param\(\[switch\]\$BridgeOnly/);
    assert.match(source,/-NoProfile -NonInteractive -ExecutionPolicy Bypass -File \$File/);
    assert.match(source,/\$NativeExitCode = \$LASTEXITCODE/);
    assert.match(source,/\$Failure\.Data\['NeurocenterChildExitCode'\] = \$NativeExitCode/);
    assert.match(source,/\$InstallerExitCode = \[int\]\$_\.Exception\.Data\['NeurocenterChildExitCode'\]/);
    assert.ok(source.indexOf('Run-Installer $OpenCodeScript')<source.indexOf('Run-Installer $BridgeScript'));
    assert.match(source,/install\.ps1\?version=\$Version&reconnect=\$Reconnect/);
    assert.match(source,/SetEnvironmentVariable\('BASE_URL', \$PreviousBaseUrl/);
    assert.match(source,/SetEnvironmentVariable\('OPENCODE_VERSION', \$PreviousVersion/);
    assert.match(source,/Remove-Item -LiteralPath \$Stage/);
    assert.ok(source.indexOf('exit $InstallerExitCode')>source.indexOf('Remove-Item -LiteralPath $Stage'));
});
