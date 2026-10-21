import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import fixture from '../../test/runtime-artifact-fixture.cjs';
import pins from '../../../services/shared/python-runtime-pins.cjs';
import {extractPinnedPythonArchive} from '../python-trusted-archive.mjs';
import {validatePythonLock,runPythonBuildTool,installPythonDependencies} from '../python-dependencies.mjs';
import {extractRelease} from '../source-adapters.mjs';
import {preparePythonRuntimeSource,pythonExecutables} from '../python-runtime.mjs';
import {packRuntime} from '../pack.mjs';
import runtime from '../../../services/shared/runtime-artifacts.cjs';

async function temporary(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'nc-python-builder-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}
async function archive(root,files){const {archive}=fixture.artifactFixture(files);const filename=path.join(root,'input.tar.gz');await fs.writeFile(filename,archive);return {filename,pin:{bytes:archive.length,sha256:createHash('sha256').update(archive).digest('hex')}};}
const lock=(wheel='url="https://files.pythonhosted.org/packages/a/example.whl", size=100, hashes={sha256="'+'a'.repeat(64)+'"}')=>'lock-version="1.0"\n[[packages]]\nname="example"\nversion="1.0"\nwheels=[{'+wheel+'}]\n';

test('Reviewed Python targets have immutable CPython assets and host UV pins',()=>{
 const assets=pins.pythonRuntimeAssets();assert.deepEqual(Object.keys(assets),['darwin-arm64','linux-x64-glibc']);
 for(const target of Object.keys(assets)){const build=pins.pythonBuildPins(target);assert.equal(assets[target].sha256,build.python.sha256);assert.equal(assets[target].entrypoint,'python/bin/python3.12');assert.ok(build.uv.bytes>0);}
 assert.throws(()=>pins.pythonBuildPins('win32-x64'),/поддерживает/);
 assets['darwin-arm64'].sha256='bad';assert.notEqual(pins.pythonRuntimeAssets()['darwin-arm64'].sha256,'bad');
});

test('Pinned tool archives copy internal aliases into regular independent files; uploaded archives still reject links',async t=>{
 const root=await temporary(t),{filename,pin}=await archive(root,[{path:'python/bin/python3.12',content:'runtime',mode:0o755},{path:'python/bin/python3',type:'2',link:'python3.12'},{path:'python/bin/python',type:'1',link:'python/bin/python3'}]);
 const output=path.join(root,'out');await extractPinnedPythonArchive(filename,pin,output);
 for(const relative of ['python3.12','python3','python']){const entry=path.join(output,'python/bin',relative),info=await fs.lstat(entry);assert.ok(info.isFile());assert.equal(info.nlink,1);assert.equal(await fs.readFile(entry,'utf8'),'runtime');assert.ok(info.mode&0o100);}
 await fs.mkdir(path.join(root,'untrusted'));await assert.rejects(extractRelease(filename,{format:'tar.gz'},path.join(root,'untrusted')),/небезопасный|Ссылка/);
});

for(const [name,files] of [
 ['outside',[{path:'alias',type:'2',link:'../../escape'}]],
 ['cycle',[{path:'a',type:'2',link:'b'},{path:'b',type:'2',link:'a'}]],
 ['absolute',[{path:'a',type:'2',link:'/private/value'}]],
 ['missing',[{path:'a',type:'2',link:'not-here'}]],
 ['directory',[{path:'folder',type:'5'},{path:'a',type:'2',link:'folder'}]],
 ['case',[{path:'Python/main',content:'a'},{path:'python/other',content:'b'}]],
 ['parent',[{path:'parent',content:'a'},{path:'parent/child',content:'b'}]],
 ['device',[{path:'device',type:'3'}]],
 ['duplicate',[{path:'same',content:'a'},{path:'same',content:'b'}]],
])test('Pinned normalization rejects '+name,async t=>{const root=await temporary(t),input=await archive(root,files);await assert.rejects(extractPinnedPythonArchive(input.filename,input.pin,path.join(root,'out')));});

test('Trusted tool bytes are checked before any archive entry is written',async t=>{
 const root=await temporary(t),{filename,pin}=await archive(root,[{path:'python',content:'runtime'}]),out=path.join(root,'out');
 await assert.rejects(extractPinnedPythonArchive(filename,{...pin,sha256:'0'.repeat(64)},out),/SHA-256/);
 await assert.rejects(fs.stat(out),{code:'ENOENT'});
 await assert.rejects(extractPinnedPythonArchive(filename,{...pin,bytes:pin.bytes+1},out),/Размер/);
});

test('Headless policy removes only pinned terminal UI descriptions and records omitted bytes',async t=>{
 const root=await temporary(t),input=await archive(root,[{path:'python/share/terminfo/A/foo',content:'one'},{path:'python/share/terminfo/a/bar',content:'two'},{path:'python/share/terminfo-extra/keep',content:'kept'},{path:'python/LICENSE',content:'license'}]);
 await assert.rejects(extractPinnedPythonArchive(input.filename,input.pin,path.join(root,'strict')),/Конфликт/);
 const output=path.join(root,'headless'),receipt=await extractPinnedPythonArchive(input.filename,input.pin,output,{headlessPython:true});
 assert.equal(receipt.policy,'headless-mcp-v1');assert.equal(receipt.omittedEntries,2);assert.equal(receipt.omittedBytes,6);assert.equal(receipt.unpackedBytes,11);
 assert.equal(await fs.readFile(path.join(output,'python/share/terminfo-extra/keep'),'utf8'),'kept');assert.equal(await fs.readFile(path.join(output,'python/LICENSE'),'utf8'),'license');
 await assert.rejects(fs.stat(path.join(output,'python/share/terminfo')),{code:'ENOENT'});
});

test('Bundled Python aliases and wheel executable resources keep execute permissions in canonical artifacts',async t=>{
 const root=await temporary(t),directory=path.join(root,'payload');
 for(const [relative,mode] of [['runtime/python/bin/python3',0o755],['runtime/python/bin/python3.12',0o755],['python-deps/playwright/driver/node',0o755],['python-deps/library.py',0o644],['entrypoint.mjs',0o644]]){
  const filename=path.join(directory,relative);await fs.mkdir(path.dirname(filename),{recursive:true});await fs.writeFile(filename,'fixture',{mode});
 }
 const executables=await pythonExecutables(directory);assert.deepEqual(executables,['python-deps/playwright/driver/node','runtime/python/bin/python3','runtime/python/bin/python3.12']);
 const archivePath=path.join(root,'ready.tar.gz'),descriptor=await packRuntime({directory,archivePath,target:'darwin-arm64',entrypoint:'entrypoint.mjs',executables}),files=await runtime.inspectRuntimeArchive(archivePath,descriptor);
 for(const file of files)assert.equal(file.executable,executables.includes(file.path));
});

test('Only public hashed wheel locks pass; path overrides and source archives fail closed',()=>{
 assert.equal(validatePythonLock(lock()).packages[0].name,'example');
 for(const bad of [lock('url="https://files.pythonhosted.org/x.whl",path="../../outside",size=100,hashes={sha256="'+'a'.repeat(64)+'"}'),lock().replace('files.pythonhosted.org','evil.example'),lock().replace('size=100','size=0'),lock().replace('a'.repeat(64),'bad'),lock()+'sdist={url="https://files.pythonhosted.org/x.tgz"}\n'])assert.throws(()=>validatePythonLock(bad));
});

test('Producer subprocesses ignore user credentials, configs and system PATH and enforce timeout',async t=>{
 const root=await temporary(t),secret=process.env.NC_PYTHON_TEST_SECRET;process.env.NC_PYTHON_TEST_SECRET='not-for-child';
 try{
  const result=await runPythonBuildTool(process.execPath,['-e','process.stdout.write(JSON.stringify(process.env))'],{directory:root}),env=JSON.parse(result.stdout);
  assert.equal(env.NC_PYTHON_TEST_SECRET,undefined);assert.equal(env.HOME,path.join(root,'home'));assert.equal(env.PATH,path.join(root,'empty-bin'));assert.equal(env.UV_PYTHON_DOWNLOADS,'never');
  await assert.rejects(runPythonBuildTool(process.execPath,['-e','setInterval(()=>{},1000)'],{directory:root,timeout:30}),/Истекло/);
 }finally{secret===undefined?delete process.env.NC_PYTHON_TEST_SECRET:process.env.NC_PYTHON_TEST_SECRET=secret;}
});

test('Resolution and sync require target markers, no-build, exact lock hashes, official index and no persistent cache',async t=>{
 const root=await temporary(t),calls=[];
 const run=async(command,args,options)=>{calls.push({command,args,options});if(args.includes('compile'))await fs.writeFile(path.join(root,'pylock.toml'),lock());};
 const result=await installPythonDependencies({plan:{requirements:['example>=1'],requiresPython:'>=3.10'},target:'linux-x64-glibc',uv:'/pinned/uv',python:'/pinned/python',directory:root,destination:path.join(root,'deps'),run});
 assert.equal(calls.length,3);assert.equal(calls[0].command,'/pinned/python');assert.ok(calls[0].args.includes('-I'));
 for(const call of calls.slice(1)){assert.ok(call.args.includes('--no-build'));assert.ok(call.args.includes('--no-python-downloads'));assert.ok(call.args.includes('--no-cache'));assert.ok(call.args.includes('x86_64-manylinux_2_17'));}
 assert.ok(calls[1].args.includes('https://pypi.org/simple'));assert.ok(calls[2].args.includes('--require-hashes'));assert.ok(calls[2].args.includes('--no-index'));assert.ok(calls[2].args.includes('copy'));assert.ok(!result.content.includes('#'));
});

test('Missing project modules and altered runtime pins fail before any producer tool can run',async t=>{
 const root=await temporary(t),directory=path.join(root,'payload');await fs.mkdir(directory);
 const source={type:'runtime',adapter:'python',python:{schemaVersion:1,projectDirectory:'.',entry:{type:'module',value:'missing'},searchPaths:['.'],requirements:[]},assets:{'darwin-arm64':{app:{directory:'.',entrypoint:'__neurocenter_python__/missing.py'},runtime:pins.pythonRuntimeAssets()['darwin-arm64']}}};
 let downloads=0;
 const helpers={prepareApp:async()=>{await fs.mkdir(path.join(directory,'app'));return {};},downloadAsset:async()=>{downloads++;throw new Error('must not execute');}};
 await assert.rejects(preparePythonRuntimeSource(source,{directory,target:'darwin-arm64',cacheDirectory:path.join(root,'cache')},helpers),error=>error.code==='PYTHON_SOURCE_INVALID');assert.equal(downloads,0);
 source.assets['darwin-arm64'].runtime.sha256='0'.repeat(64);
 await assert.rejects(preparePythonRuntimeSource(source,{directory,target:'darwin-arm64',cacheDirectory:path.join(root,'cache')},helpers),error=>error.code==='PYTHON_SOURCE_INVALID');assert.equal(downloads,0);
});
