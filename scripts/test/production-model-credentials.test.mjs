import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,rm,readFile,stat} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {ensureModelCredentialKey,modelCredentialIdentity} from '../workspace/model-credentials.mjs';
import {assertProductionModelKey,productionModelKeyIdentity} from '../production/model-credentials.mjs';
import {storedModelKeyIds} from '../workspace/model-credential-store.mjs';
async function fixture(t){const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'nc-production-model-key-')));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
const config=directory=>({secrets:{model_credential_key:{file:path.join(directory,'secrets/model_credential_key')}}});
const sql=(ids=[],present=true)=>async query=>query.includes('to_regclass')?(present?'t':'f'):JSON.stringify(ids);
test('Preflight разрешает первичную подготовку только при отсутствии stored credentials, не создавая файл',async t=>{
 const root=await fixture(t);assert.deepEqual(await assertProductionModelKey(root,config(root),sql(),{allowMissing:true}),{required:true,keyId:null});
 await assert.rejects(stat(path.join(root,'secrets')),{code:'ENOENT'});
 await assert.rejects(assertProductionModelKey(root,config(root),sql(['a'.repeat(24)]),{allowMissing:true}),/Восстановите исходные/);
 await assert.rejects(stat(path.join(root,'secrets')),{code:'ENOENT'});
});
test('Restore требует ключ уже в закрытой конфигурации и не создаёт новый даже при пустом каталоге',async t=>{
 const root=await fixture(t);await assert.rejects(productionModelKeyIdentity(root,config(root)),/автоматическая замена запрещена/);
 await assert.rejects(stat(path.join(root,'secrets')),{code:'ENOENT'});
});
test('Совпавший сохранённый keyId разрешает восстановление всех исторических connections',async t=>{
 const root=await fixture(t);await ensureModelCredentialKey(root);const identity=await modelCredentialIdentity(root);
 assert.deepEqual(await assertProductionModelKey(root,config(root),sql([identity.keyId])),{required:true,keyId:identity.keyId});
});
test('Новый корректный ключ из свежего configure не расшифровывает старый каталог и не заменяется автоматически',async t=>{
 const root=await fixture(t),filename=await ensureModelCredentialKey(root),before=await readFile(filename);
 await assert.rejects(assertProductionModelKey(root,config(root),sql(['a'.repeat(24)])),/Восстановите исходные/);
 assert.deepEqual(await readFile(filename),before);
});
test('Префикс первого релиза без таблицы remote connections допускает создание нового секрета',async t=>{
 const root=await fixture(t);assert.deepEqual(await storedModelKeyIds(sql([],false)),[]);assert.equal((await assertProductionModelKey(root,config(root),sql([],false),{allowMissing:true})).keyId,null);
});
for(const value of [null,[null],['bad'],{},['a'.repeat(24),null]])test('Повреждённые DB keyId не разрешают новый ключ: '+JSON.stringify(value),async()=>{
 await assert.rejects(storedModelKeyIds(async query=>query.includes('to_regclass')?'t':JSON.stringify(value)),/Восстановите исходные/);
});
test('Неполная новая конфигурация и чужой путь не обходят проверку ключа',async t=>{
 const root=await fixture(t);await assert.rejects(assertProductionModelKey(root,{},()=>{throw Error('Unexpected SQL');}),/Восстановите исходные/);
 await assert.rejects(productionModelKeyIdentity(root,{secrets:{model_credential_key:{file:'/foreign/key'}}}),/Восстановите исходные/);
});
