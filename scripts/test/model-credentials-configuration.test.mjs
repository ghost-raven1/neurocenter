import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,readFile,writeFile,rm,chmod,symlink,link,stat,mkdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {ensureModelCredentialKey,modelCredentialEnvironment,modelCredentialIdentity} from '../workspace/model-credentials.mjs';

async function fixture(t){const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'nc-model-key-')));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
test('Dev готовит постоянный серверный ключ; повтор сохраняет шифрованные модели и не раскрывает ключ в env',async t=>{
 const root=await fixture(t),first=await modelCredentialEnvironment(root,{}),second=await modelCredentialEnvironment(root,{});
 assert.deepEqual(first,second);assert.deepEqual(Object.keys(first),['NEUROCENTER_MODEL_CREDENTIAL_KEY_FILE']);
 const filename=first.NEUROCENTER_MODEL_CREDENTIAL_KEY_FILE,bytes=await readFile(filename,'utf8');assert.match(bytes,/^[A-Za-z0-9+/]{43}=\n$/);
 assert.equal((await stat(filename)).mode&0o777,0o600);assert.equal((await stat(path.dirname(filename))).mode&0o777,0o700);
 assert.ok(!JSON.stringify(first).includes(bytes.trim()));
});
test('Явные настройки оператора не изменяются',async t=>{
 const root=await fixture(t),filename=path.join(root,'operator.key');await writeFile(filename,Buffer.alloc(32,7).toString('base64')+'\n',{mode:0o600});
 assert.deepEqual(await modelCredentialEnvironment(root,{NEUROCENTER_MODEL_CREDENTIAL_KEY:Buffer.alloc(32,7).toString('base64')}),{});
 assert.deepEqual(await modelCredentialEnvironment(root,{NEUROCENTER_MODEL_CREDENTIAL_KEY_FILE:filename}),{});
 await assert.rejects(modelCredentialEnvironment(root,{NEUROCENTER_MODEL_CREDENTIAL_KEY:'operator'}));
});
test('Потерянный ранее созданный ключ не заменяется новым',async t=>{
 const root=await fixture(t),filename=await ensureModelCredentialKey(root);await rm(filename);
 await assert.rejects(ensureModelCredentialKey(root),/автоматическая замена запрещена/);
 await assert.rejects(stat(filename),{code:'ENOENT'});
});
test('Подмена ключа даже другим корректным base64 обнаруживается по сохранённому identity',async t=>{
 const root=await fixture(t),filename=await ensureModelCredentialKey(root);await writeFile(filename,Buffer.alloc(32,1).toString('base64')+'\n');
 await assert.rejects(ensureModelCredentialKey(root),/автоматическая замена запрещена/);
});
for(const mode of ['symlink','hardlink','corrupt','public-permissions'])test('Небезопасный файл ключа отклоняется: '+mode,async t=>{
 const root=await fixture(t),filename=await ensureModelCredentialKey(root),outside=path.join(root,'other');
 if(mode==='symlink'){await rm(filename);await writeFile(outside,'untouched');await symlink(outside,filename);}
 if(mode==='hardlink')await link(filename,outside);
 if(mode==='corrupt')await writeFile(filename,'invalid');
 if(mode==='public-permissions')await chmod(filename,0o644);
 await assert.rejects(ensureModelCredentialKey(root));if(mode==='symlink')assert.equal(await readFile(outside,'utf8'),'untouched');
});
test('Публичный или подменённый каталог не получает новый ключ',async t=>{
 const root=await fixture(t);await chmod(root,0o755);await assert.rejects(ensureModelCredentialKey(root));
 await chmod(root,0o700);await rm(path.join(root,'secrets'),{recursive:true});const outside=path.join(root,'outside');await mkdir(outside);await symlink(outside,path.join(root,'secrets'));
 await assert.rejects(ensureModelCredentialKey(root));
});
test('Read-only identity не создаёт отсутствующие файлы и не раскрывает ключ',async t=>{
 const root=await fixture(t);assert.equal(await modelCredentialIdentity(root,{allowMissing:true}),undefined);
 await assert.rejects(stat(path.join(root,'secrets')),{code:'ENOENT'});
 const filename=await ensureModelCredentialKey(root),identity=await modelCredentialIdentity(root);
 assert.match(identity.keyId,/^[a-f0-9]{24}$/);assert.equal(identity.markerPresent,true);
 assert.ok(!JSON.stringify(identity).includes((await readFile(filename,'utf8')).trim()));
});
test('Read-only preflight не принимает публичный каталог даже до первой генерации',async t=>{
 const root=await fixture(t);await chmod(root,0o755);await assert.rejects(modelCredentialIdentity(root,{allowMissing:true}),/автоматическая замена запрещена/);await assert.rejects(stat(path.join(root,'secrets')),{code:'ENOENT'});
});
test('Потерянный marker восстанавливается из того же ключа без ротации',async t=>{
 const root=await fixture(t),filename=await ensureModelCredentialKey(root),before=await readFile(filename,'utf8');await rm(filename+'.id');
 assert.equal((await modelCredentialIdentity(root)).markerPresent,false);await ensureModelCredentialKey(root);
 assert.equal(await readFile(filename,'utf8'),before);assert.equal((await modelCredentialIdentity(root)).markerPresent,true);
});
test('Конкурентные процессы первоначальной настройки получают одну identity без ротации',{timeout:15000},async t=>{
 const root=await fixture(t),module=new URL('../workspace/model-credentials.mjs',import.meta.url).href;
 const script=`import {ensureModelCredentialKey,modelCredentialIdentity} from ${JSON.stringify(module)};process.send('ready');process.once('message',async()=>{try{await ensureModelCredentialKey(process.argv[1]);process.send({keyId:(await modelCredentialIdentity(process.argv[1])).keyId});process.disconnect();}catch(error){console.error(error.message);process.exitCode=1;process.disconnect();}});`;
 const children=Array.from({length:12},()=>spawn(process.execPath,['--input-type=module','--eval',script,root],{stdio:['ignore','ignore','pipe','ipc']}));
 t.after(()=>{for(const child of children)if(child.exitCode===null&&!child.signalCode)child.kill('SIGKILL');});
 await Promise.all(children.map(child=>once(child,'message')));
 const results=children.map(child=>new Promise((resolve,reject)=>{let error='',message;child.stderr.on('data',chunk=>error+=chunk);child.once('message',value=>message=value);child.once('close',code=>{try{assert.equal(code,0,error);assert.match(message?.keyId,/^[a-f0-9]{24}$/);resolve(message.keyId);}catch(cause){reject(cause);}});}));
 children.forEach(child=>child.send('go'));const ids=await Promise.all(results);assert.equal(new Set(ids).size,1);assert.equal((await modelCredentialIdentity(root)).keyId,ids[0]);
});
test('Чтение ждёт временный второй hardlink atomic publication, постоянные hardlinks по-прежнему запрещены',async t=>{
 const root=await fixture(t),filename=path.join(root,'secrets/model_credential_key'),original=fs.link;
 let published,release;const linked=new Promise(resolve=>published=resolve),hold=new Promise(resolve=>release=resolve);
 fs.link=async(from,to)=>{await original(from,to);if(to===filename){published();await hold;}};syncBuiltinESMExports();
 let first,second;
 try{first=ensureModelCredentialKey(root);await linked;second=ensureModelCredentialKey(root);setTimeout(release,50);const result=await Promise.all([first,second]);assert.deepEqual(result,[filename,filename]);}
 finally{release();await Promise.allSettled([first,second]);fs.link=original;syncBuiltinESMExports();}
});
