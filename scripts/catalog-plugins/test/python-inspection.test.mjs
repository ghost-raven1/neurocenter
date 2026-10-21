import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {detectReadyPayload,inspectGithubReleaseAsset,inspectGithubRepository} from '../release-inspection.mjs';
import {inspectUploadArchive} from '../upload-inspection.mjs';
import sourcePlan from '../../../services/shared/python-source-plan.cjs';
import repository from '../../../services/shared/repository-source.cjs';
import archive from '../../../services/shared/archive-source.cjs';
import sourceRuntime from '../../../services/shared/tool-runtime-source.cjs';
import runtimeFixture from '../../test/runtime-artifact-fixture.cjs';

async function fixture(files,run){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'neurocenter-python-inspection-'));
 try{for(const[name,content]of Object.entries(files)){await fs.mkdir(path.dirname(path.join(root,name)),{recursive:true});await fs.writeFile(path.join(root,name),content);}await run(root);}
 finally{await fs.rm(root,{recursive:true,force:true});}
}
const project='[project]\nname="mcp-server-time"\nversion="1.0.0"\nrequires-python=">=3.10"\ndependencies=["mcp>=1.29,<2"]\n[project.scripts]\nmcp-server-time="mcp_server_time:main"\n[build-system]\nrequires=["hatchling"]\nbuild-backend="hatchling.build"\n';
test('PEP621 src layout produces a pinned Python plan without executing the build backend',async()=>{
 await fixture({'pyproject.toml':project,'src/mcp_server_time/__init__.py':'def main():\n    print("ready")\n'},async root=>{
  const choices=await detectReadyPayload(root);assert.equal(choices.length,1);
  assert.equal(choices[0].entrypoint,'__neurocenter_python__/mcp-server-time.py');
  assert.deepEqual(choices[0].python,{schemaVersion:1,projectDirectory:'.',entry:{type:'callable',value:'mcp_server_time:main'},searchPaths:['.','src'],requirements:['mcp>=1.29,<2'],requiresPython:'>=3.10',distribution:{name:'mcp-server-time',version:'1.0.0'}});
  assert.deepEqual(choices[0].targets,['darwin-arm64','linux-x64-glibc']);
  assert.equal(choices[0].runtimeAssets['darwin-arm64'].entrypoint,'python/bin/python3.12');
 });
});
test('A standalone .py and a wrapped package __main__ infer safe script/module entrypoints',async()=>{
 await fixture({'hello.py':'print("ready")\n'},async root=>{
  const[choice]=await detectReadyPayload(root);assert.deepEqual(choice.python.entry,{type:'script',value:'hello.py'});assert.deepEqual(choice.python.requirements,[]);
 });
 await fixture({'wrapper/pkg/__main__.py':'print("ready")\n','wrapper/pkg/__init__.py':'','wrapper/requirements.txt':'# dependencies\nfoo--bar>=1\nrequests[security, socks]>=2; python_version >= "3.10" # supported\n'},async root=>{
  const[choice]=await detectReadyPayload(root);assert.equal(choice.python.projectDirectory,'wrapper');assert.deepEqual(choice.python.entry,{type:'module',value:'pkg'});
  assert.deepEqual(choice.python.requirements,['foo--bar>=1','requests[security, socks]>=2; python_version >= "3.10"']);
 });
});
test('Package-only source archives keep the package root for relative imports, including repeated wrapper directories',async()=>{
 for(const prefix of ['', 'wrapper/', 'outer/wrapper/']){
  await fixture({[prefix+'pkg/__init__.py']:'',[prefix+'pkg/__main__.py']:'from .helper import run\nrun()\n',[prefix+'pkg/helper.py']:'def run(): pass\n'},async root=>{
   const[choice]=await detectReadyPayload(root);assert.equal(choice.python.projectDirectory,prefix?prefix.slice(0,-1):'.');assert.deepEqual(choice.python.entry,{type:'module',value:'pkg'});
  });
 }
 await fixture({'pkg/__init__.py':'','pkg/cli.py':'from .helper import run\nif __name__ == "__main__": run()\n','pkg/helper.py':'def run(): pass\n'},async root=>{
  const[choice]=await detectReadyPayload(root);assert.equal(choice.python.projectDirectory,'.');assert.deepEqual(choice.python.entry,{type:'module',value:'pkg.cli'});
 });
});
test('Declared commands require explicit selection when multiple and never execute configuration',async()=>{
 await fixture({'pyproject.toml':project.replace('version="1.0.0"','version="1.0.0"\nversion="2.0.0"'),'src/mcp_server_time/__init__.py':'def main():\n    pass\n'},async root=>{
  await assert.rejects(detectReadyPayload(root),/TOML/);
 });
 const two=project.replace('[build-system]','other="mcp_server_time:main"\n[build-system]');
 await fixture({'pyproject.toml':two,'src/mcp_server_time/__init__.py':'raise RuntimeError("must never execute")\n'},async root=>{
  const choices=await detectReadyPayload(root);assert.deepEqual(choices.map(choice=>choice.entrypoint),['__neurocenter_python__/mcp-server-time.py','__neurocenter_python__/other.py']);
 });
});
test('Python constraints use PEP440 including compatible releases, wildcards and exclusions',async()=>{
 for(const specifier of ['>=3.12,<3.13','~=3.12.2','==3.12.*','>=3.10,!=3.12.14']){
  await fixture({'pyproject.toml':project.replace('>=3.10',specifier),'src/mcp_server_time/__init__.py':'def main(): pass\n'},async root=>assert.equal((await detectReadyPayload(root))[0].python.requiresPython,specifier));
 }
 for(const specifier of ['>=3.13','!=3.12.*','~=bad']){
  await fixture({'pyproject.toml':project.replace('>=3.10',specifier),'src/mcp_server_time/__init__.py':'def main(): pass\n'},async root=>assert.rejects(detectReadyPayload(root),/Python|PEP 440/));
 }
});
test('Dynamic metadata, missing module, unsafe callables, legacy builds and reserved paths fail before queueing',async()=>{
 const cases=[
  [{'pyproject.toml':project.replace('version="1.0.0"','dynamic=["version"]'),'src/mcp_server_time/__init__.py':''},/Динамические/],
  [{'pyproject.toml':project.replace('dependencies=["mcp>=1.29,<2"]','dynamic=["dependencies"]'),'src/mcp_server_time/__init__.py':''},/Динамические/],
  [{'pyproject.toml':project.replace('requires-python=">=3.10"','dynamic=["requires-python"]'),'src/mcp_server_time/__init__.py':''},/Динамические/],
  [{'pyproject.toml':project,'src/other/__init__.py':''},/не найден/],
  [{'pyproject.toml':project.replace('mcp_server_time:main','mcp_server_time:main()'),'src/mcp_server_time/__init__.py':''},/без выражений/],
  [{'setup.py':'raise RuntimeError("never run")\n','main.py':'print("ready")\n'},/setup.py/],
  [{'pkg/setup.py':'raise RuntimeError("never run")\n','pkg/__main__.py':'print("ready")\n','pkg/__init__.py':''},/setup.py/],
  [{'main.py':'print("ready")\n','__neurocenter_python__/entry.py':''},/зарезервирована/],
  [{'main.py':'print("ready")\n','__NEUROCENTER_PYTHON__/entry.py':''},/зарезервирована/],
  [{'pyproject.toml':project.replace('mcp-server-time="mcp_server_time:main"','CON="mcp_server_time:main"'),'src/mcp_server_time/__init__.py':''},/переносимым/],
  [{'pkg/__init__.py':''},/не найден/],
 ];
 for(const[files,error]of cases)await fixture(files,root=>assert.rejects(detectReadyPayload(root),error));
});
test('PEP621 dependencies are authoritative, and ordinary Python helpers may exceed 64KiB',async()=>{
 await fixture({'pyproject.toml':project.replace('dependencies=["mcp>=1.29,<2"]',''),'src/mcp_server_time/__init__.py':'def main(): pass\n','requirements.txt':'--index-url https://bad.example/\n'},async root=>assert.deepEqual((await detectReadyPayload(root))[0].python.requirements,[]));
 await fixture({'main.py':'if __name__ == "__main__":\n    pass\n','helper.py':'# helper\n'.repeat(10000)},async root=>assert.equal((await detectReadyPayload(root))[0].python.entry.value,'main.py'));
});
test('Pip options, paths, URLs and line continuations cannot become dependency instructions',async()=>{
 for(const value of ['-e .','-r requirements-extra.txt','-c constraints.txt','--index-url https://bad.example/','--find-links /tmp/wheels','./package','../package','git+https://github.com/x/y','package @ https://bad.example/package.whl','package\\\n--index-url bad','package\n--no-deps']){
  assert.throws(()=>sourcePlan.validatePythonRequirements([value]),/зависимости|Зависимости/);
  await fixture({'main.py':'print("ready")\n','requirements.txt':value+'\n'},async root=>assert.rejects(detectReadyPayload(root),/зависимости|Зависимости/));
 }
});
test('Runtime plans reject traversal, expressions, unknown data and runtimes without immutable URLs',()=>{
 const python={schemaVersion:1,projectDirectory:'.',entry:{type:'script',value:'main.py'},searchPaths:['.'],requirements:[]};
 for(const changes of [{projectDirectory:'../outside'},{entry:{type:'callable',value:'os:system("sh")'}},{searchPaths:['../outside']},{requirements:['--no-build']},{distribution:{name:'safe',version:'1.0\nRequires-Dist: bad'}},{command:'python'}])assert.throws(()=>sourcePlan.validatePythonPlan({...python,...changes}));
 assert.throws(()=>sourceRuntime.validateRuntimeSource({type:'runtime',adapter:'native',assets:{'darwin-arm64':{app:{directory:'.',entrypoint:'tool'}}},python}));
 assert.throws(()=>sourceRuntime.validateRuntimeSource({type:'runtime',adapter:'python',assets:{'darwin-arm64':{app:{directory:'.',entrypoint:'main.py'},runtime:{directory:'.',entrypoint:'python'}}},python}));
});
test('GitHub repository, release and local upload persist the same source plan and exact runtime pins',async()=>{
 await fixture({},async root=>{
  const files=[{path:'pyproject.toml',content:project},{path:'src/mcp_server_time/__init__.py',content:'def main(): pass\n'}];
  const bytes=runtimeFixture.artifactFixture(files).archive,filename=path.join(root,'time.tar.gz');await fs.writeFile(filename,bytes);
  const sha256=createHash('sha256').update(bytes).digest('hex'),url='https://github.com/owner/repo/releases/download/v1/time.tar.gz';
  const released=await inspectGithubReleaseAsset({name:'time.tar.gz',url,format:'tar.gz',bytes:bytes.length},undefined,{downloadAsset:async()=>({filename,sha256,compressedBytes:bytes.length})});
  const uploaded=await inspectUploadArchive(filename,{name:'time.tar.gz',format:'tar.gz'});
  const commit='a'.repeat(40),repoBytes=runtimeFixture.artifactFixture(files.map(file=>({...file,path:`repo-${commit}/`+file.path}))).archive,archivePath=path.join(root,'repo.tar.gz');await fs.writeFile(archivePath,repoBytes);
  const snapshotSha256=createHash('sha256').update(repoBytes).digest('hex');
  const checked=await inspectGithubRepository({type:'repository',url:'https://github.com/owner/repo',commit},undefined,{downloadArchive:async()=>({archivePath,sha256:snapshotSha256})});
  assert.equal(checked.name,'mcp-server-time');assert.equal(released.name,'mcp-server-time');assert.equal(uploaded.name,'mcp-server-time');
  assert.deepEqual(released.runtimeSource.python,uploaded.choices[0].python);assert.deepEqual(checked.runtimeSource.python,released.runtimeSource.python);
  assert.deepEqual(uploaded.choices[0].runtimeAssets['darwin-arm64'],checked.runtimeSource.assets['darwin-arm64'].runtime);
  const pinned=repository.validateRepositorySource({type:'repository',url:'https://github.com/owner/repo',commit,entrypoint:checked.entrypoint,runtimeSource:checked.runtimeSource,snapshotSha256});
  assert.deepEqual(JSON.parse(JSON.stringify(pinned)).runtimeSource,checked.runtimeSource);
  assert.deepEqual(repository.validateRepositorySource({type:'repository',url:'https://github.com/owner/repo',commit,entrypoint:released.entrypoint,runtimeSource:released.runtimeSource,release:{tag:'v1',asset:'time.tar.gz',id:1,assetId:2,sha256}}).runtimeSource,released.runtimeSource);
  assert.deepEqual(archive.validateArchiveSource({type:'archive',file:'source.upload',sha256,bytes:bytes.length,format:'tar.gz',runtimeSource:checked.runtimeSource}).runtimeSource,checked.runtimeSource);
  assert.deepEqual(repository.parseRepositoryUrl('https://github.com/owner/repo/blob/main/src/mcp_server_time/__init__.py').entrypoint,'src/mcp_server_time/__init__.py');
  const blob=await inspectGithubRepository({type:'repository',url:'https://github.com/owner/repo',commit},'src/mcp_server_time/__init__.py',{downloadArchive:async()=>({archivePath,sha256:snapshotSha256})});
  assert.equal(blob.entrypoint,checked.entrypoint);
  const two=runtimeFixture.artifactFixture(files.map(file=>({...file,path:`repo-${commit}/`+file.path,content:file.path==='pyproject.toml'?twoCommands(project):file.content}))).archive;
  const twoArchive=path.join(root,'two.tar.gz');await fs.writeFile(twoArchive,two);
  const ambiguous=await inspectGithubRepository({type:'repository',url:'https://github.com/owner/repo',commit},'src/mcp_server_time/__init__.py',{downloadArchive:async()=>({archivePath:twoArchive,sha256:createHash('sha256').update(two).digest('hex')})});
  assert.equal(ambiguous.requiresEntrypointChoice,true);assert.equal(ambiguous.runtimeSource,undefined);
 });
});
function twoCommands(value){return value.replace('[build-system]','other="mcp_server_time:main"\n[build-system]');}
