import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,access,realpath,utimes} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {sha256} from '../models/bundle-manifest.mjs';
import {hydrateModelBundle,rollbackManagedModelBundle} from '../models/bundle.mjs';
import {recoverManagedModelBundle} from '../models/bundle-managed.mjs';

const ampleDisk=async()=>({bavail:64n*1024n**3n,bsize:1n});
const base='https://github.com/ghost-raven1/neurocenter/releases/download/models-fixture.1';

/** Небольшие реальные SHA-файлы проверяют смену тегов без весов моделей и внешней сети. */
async function fixture(action) {
    const root=await realpath(await mkdtemp(path.join(tmpdir(),'nc-managed-models-'))),directory=path.join(root,'models');
    function bundle(version,names=['fixture-one','fixture-two']) {
        const bytes=new Map(),locks=[],files=[];
        const config=Buffer.from('{"public":true}'),configHash=sha256(config);bytes.set(configHash,config);
        for(const name of names) {
            const weights=Buffer.from(name+' weights '+version),weightHash=sha256(weights);bytes.set(weightHash,weights);
            const manifest={schemaVersion:2,config:{digest:'sha256:'+configHash,size:config.length},layers:[{digest:'sha256:'+weightHash,size:weights.length}]};
            const content=Buffer.from(JSON.stringify(manifest));
            locks.push({schemaVersion:1,model:name+':1',manifest,manifestSha256:sha256(content)});
            files.push({path:`models/manifests/registry.ollama.ai/library/${name}/1`,size:content.length,sha256:sha256(content),inlineBase64:content.toString('base64')});
        }
        for(const [digest,content] of bytes)files.push({path:'models/blobs/sha256-'+digest,size:content.length,sha256:digest,
            parts:[{name:`model-${digest}-001.bin`,size:content.length,sha256:digest}]});
        const manifest={schemaVersion:1,kind:'neurocenter-model-bundle',releaseBaseUrl:base,files};
        let requests=0;
        const run=options=>hydrateModelBundle({directory,manifest,locks,readDisk:ampleDisk,fetch:async url=>{
            requests++;return new Response(bytes.get(path.basename(new URL(url).pathname).split('-')[1]));
        },...options});
        return {manifest,locks,bytes,run,requests:()=>requests,tags:files.filter(file=>file.inlineBase64)};
    }
    const first=bundle('one'),second=bundle('two');
    const active=()=>readFile(path.join(directory,'.bundle-managed/active.json'),'utf8').then(JSON.parse);
    const contents=()=>Promise.all(first.tags.map(file=>readFile(path.join(directory,file.path),'utf8')));
    try{await action({root,directory,first,second,active,contents,bundle});}finally{await rm(root,{recursive:true,force:true});}
}

/** Отдельный процесс обрывается до очистки журнала, минуя catch/finally активации. */
async function crashActivation(root,directory,tags,committed=false) {
    const filename=path.join(root,'interrupted-tags.json');await writeFile(filename,JSON.stringify(tags));
    const module=fileURLToPath(new URL('../models/bundle-managed.mjs',import.meta.url));
    const result=spawnSync(process.execPath,['--input-type=module','-e',`
        import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';
        const committed=process.argv[4]==='true',unlink=fs.unlink;
        fs.unlink=async(filename,...args)=>{
            if(committed&&filename.endsWith('/.bundle-managed/pending.json'))process.exit(83);
            return unlink(filename,...args);
        };syncBuiltinESMExports();
        const {activateManagedModelBundle}=await import(process.argv[1]);
        await activateManagedModelBundle(process.argv[2],JSON.parse(await fs.readFile(process.argv[3],'utf8')),
            {onBytes:()=>{if(!committed)process.exit(83);}});
    `,module,directory,filename,String(committed)],{encoding:'utf8',timeout:5000});
    assert.equal(result.status,83,result.stderr);
}

test('Новая SHA прежнего тега обновляется только после полного скачивания; предыдущие blobs остаются',async()=>fixture(async({directory,first,second,active,contents})=>{
    await first.run();const previous=await active(),before=await contents();
    await second.run({downloadOnly:true});assert.deepEqual(await contents(),before);assert.deepEqual(await active(),previous);
    const requests=second.requests();await second.run();assert.equal(second.requests(),requests);
    const current=await active();assert.equal(current.previous,previous.revision);assert.notEqual(current.revision,previous.revision);
    await second.run({verifyOnly:true});
    for(const file of first.manifest.files.filter(file=>file.parts))assert.equal(sha256(await readFile(path.join(directory,file.path))),file.sha256);
}));

test('Возврат прежнего полного комплекта не требует сети и оставляет новую версию для следующего возврата',async()=>fixture(async({first,second,directory,active,contents})=>{
    await first.run();const expected=await contents(),original=await active();await second.run();const updated=await active();
    const result=await rollbackManagedModelBundle(directory);assert.equal(result.revision,original.revision);
    assert.deepEqual(await contents(),expected);await first.run({verifyOnly:true});
    assert.equal((await active()).previous,updated.revision);
}));

test('Прежняя установка получает квитанцию через предзагрузку без изменения тегов',async()=>fixture(async({first,second,directory,contents,active})=>{
    await first.run();const expected=await contents();await rm(path.join(directory,'.bundle-managed'),{recursive:true});
    await first.run({verifyOnly:true});await assert.rejects(access(path.join(directory,'.bundle-managed')));
    await first.run({downloadOnly:true});assert.ok((await active()).revision);assert.deepEqual(await contents(),expected);
    await second.run();await second.run({verifyOnly:true});
}));

test('Неизвестный старый тег без квитанции не заменяется и объясняет восстановление',async()=>fixture(async({first,second,directory,contents})=>{
    await first.run();const expected=await contents();await rm(path.join(directory,'.bundle-managed'),{recursive:true});
    await assert.rejects(second.run(),/immutable alias/);assert.equal(second.requests(),0);assert.deepEqual(await contents(),expected);
}));

test('Повреждённый принадлежащий поставке тег не перезаписывается при обновлении',async()=>fixture(async({first,second,directory})=>{
    await first.run();const file=path.join(directory,first.tags[0].path);await writeFile(file,'USER MODIFIED TAG');
    await assert.rejects(second.run(),/не принадлежит/);assert.equal(second.requests(),0);assert.equal(await readFile(file,'utf8'),'USER MODIFIED TAG');
}));

test('Повреждение прежних весов останавливает возврат до переключения любых тегов',async()=>fixture(async({first,second,directory,contents,active})=>{
    await first.run();await second.run();const before=await contents(),pointer=await active();
    const old=first.manifest.files.find(file=>file.parts&& !second.manifest.files.some(other=>other.sha256===file.sha256));
    await writeFile(path.join(directory,old.path),Buffer.alloc(old.size));
    await assert.rejects(rollbackManagedModelBundle(directory),/SHA/);assert.deepEqual(await contents(),before);assert.deepEqual(await active(),pointer);
}));

test('Обрыв загрузки новой версии сохраняет прежний активный комплект',async()=>fixture(async({first,second,contents,active})=>{
    await first.run();const before=await contents(),pointer=await active();
    await assert.rejects(second.run({fetch:async()=>{throw new Error('INTERRUPTED');}}),/INTERRUPTED/);
    assert.deepEqual(await contents(),before);assert.deepEqual(await active(),pointer);await first.run({verifyOnly:true});
}));

test('Ошибка после первого переключённого тега возвращает весь прежний комплект',async()=>fixture(async({first,second,contents,active})=>{
    await first.run();const before=await contents(),pointer=await active();
    // После публикации новых blobs прогресс активации содержит тег, затем симулируется отказ callback.
    let count=0;
    await assert.rejects(second.run({onProgress:event=>{if(event.stage==='activating'&&event.completed>0&&++count===3)throw new Error('INTERRUPTED');}}),/INTERRUPTED/);
    assert.deepEqual(await contents(),before);assert.deepEqual(await active(),pointer);await first.run({verifyOnly:true});
}));

test('Прерванный процесс оставляет журнал; offline CLI восстанавливает прежний комплект до предзагрузки',async()=>fixture(async({root,directory,first,second,contents,active})=>{
    await first.run();const before=await contents(),pointer=await active();
    // Все новые blobs готовы до имитации аварии процесса во время смены двух тегов.
    for(const [digest,bytes] of second.bytes)await writeFile(path.join(directory,'models/blobs/sha256-'+digest),bytes);
    await crashActivation(root,directory,second.tags);const partial=await contents();assert.notDeepEqual(partial,before);
    for(const mode of [{verifyOnly:true},{downloadOnly:true}]) {
        await assert.rejects(first.run(mode),error=>error.code==='MODEL_RECOVERY_REQUIRED'&&/--recover-only/.test(error.message));
        assert.deepEqual(await contents(),partial);
    }
    const preload=path.join(root,'deny-network.mjs');await writeFile(preload,'globalThis.fetch=()=>{throw new Error("Сеть при восстановлении запрещена")};');
    const cli=fileURLToPath(new URL('../models/bundle-cli.mjs',import.meta.url));
    const recovered=spawnSync(process.execPath,['--import',preload,cli,'--recover-only','--directory',directory],{encoding:'utf8',timeout:5000});
    assert.equal(recovered.status,0,recovered.stderr);assert.deepEqual(JSON.parse(recovered.stdout),{ok:true,recovered:true});
    assert.deepEqual(await contents(),before);assert.deepEqual(await active(),pointer);
    await first.run({verifyOnly:true});await assert.rejects(access(path.join(directory,'.bundle-managed/pending.json')));
    await second.run({downloadOnly:true});assert.deepEqual(await contents(),before);assert.deepEqual(await active(),pointer);
    await second.run();await second.run({verifyOnly:true});
}));

test('Восстановление без журнала не создаёт каталог и не меняет готовую поставку',async()=>fixture(async({root,directory,first,contents,active})=>{
    const missing=path.join(root,'absent');assert.deepEqual(await recoverManagedModelBundle(missing),{ok:true,recovered:false});
    await assert.rejects(access(missing),{code:'ENOENT'});
    await first.run();const before=await contents(),pointer=await active();
    assert.deepEqual(await recoverManagedModelBundle(directory),{ok:true,recovered:false});
    assert.deepEqual(await contents(),before);assert.deepEqual(await active(),pointer);
}));

test('Восстановление не затирает неизвестные изменения после обрыва и сохраняет журнал',async()=>fixture(async({root,directory,first,second,active,contents})=>{
    await first.run();const pointer=await active();
    for(const [digest,bytes] of second.bytes)await writeFile(path.join(directory,'models/blobs/sha256-'+digest),bytes);
    await crashActivation(root,directory,second.tags);
    await writeFile(path.join(directory,first.tags[1].path),'USER MODIFIED TAG');const partial=await contents();
    await assert.rejects(recoverManagedModelBundle(directory),{code:'MODEL_MANAGED_CONFLICT'});
    assert.deepEqual(await contents(),partial);assert.deepEqual(await active(),pointer);
    await access(path.join(directory,'.bundle-managed/pending.json'));
}));

test('После фиксации нового указателя восстановление только очищает журнал и сохраняет новый комплект',async()=>fixture(async({root,directory,first,second,active,contents})=>{
    await first.run();const previous=await active();
    for(const [digest,bytes] of second.bytes)await writeFile(path.join(directory,'models/blobs/sha256-'+digest),bytes);
    await crashActivation(root,directory,second.tags,true);const pointer=await active(),before=await contents();
    assert.notEqual(pointer.revision,previous.revision);await access(path.join(directory,'.bundle-managed/pending.json'));
    assert.deepEqual(await recoverManagedModelBundle(directory),{ok:true,recovered:true});
    assert.deepEqual(await active(),pointer);assert.deepEqual(await contents(),before);
    await second.run({verifyOnly:true});await assert.rejects(access(path.join(directory,'.bundle-managed/pending.json')),{code:'ENOENT'});
}));

test('Пользовательские файлы и отдельные модели сохраняются при обновлении и возврате',async()=>fixture(async({directory,first,second})=>{
    await first.run();const custom=path.join(directory,'models/manifests/registry.ollama.ai/library/custom/1');await mkdir(path.dirname(custom));
    await writeFile(custom,'CUSTOM');await writeFile(path.join(directory,'user-key'),'SECRET');await second.run();await rollbackManagedModelBundle(directory);
    assert.equal(await readFile(custom,'utf8'),'CUSTOM');assert.equal(await readFile(path.join(directory,'user-key'),'utf8'),'SECRET');
    assert.ok((await readdir(path.join(directory,'.bundle-managed/revisions'))).length===2);
}));


test('Удаление модели из поставки и возврат меняют только принадлежащие поставке теги',async()=>fixture(async({first,bundle,directory,active})=>{
    await first.run();const original=await active(),subset=bundle('one',['fixture-one']);
    const removed=path.join(directory,first.tags[1].path);
    await subset.run({downloadOnly:true});await access(removed);assert.deepEqual(await active(),original);
    await subset.run();await assert.rejects(access(removed));assert.equal((await active()).previous,original.revision);
    await rollbackManagedModelBundle(directory);await access(removed);await first.run({verifyOnly:true});
}));

test('Возврат поставки удаляет добавленный управляемый тег, сохраняя его blobs',async()=>fixture(async({first,bundle,directory})=>{
    await first.run();const expanded=bundle('one',['fixture-one','fixture-two','fixture-extra']);await expanded.run();
    const extra=expanded.tags.find(tag=>tag.path.includes('fixture-extra'));
    await access(path.join(directory,extra.path));await rollbackManagedModelBundle(directory);await assert.rejects(access(path.join(directory,extra.path)));
    for(const file of expanded.manifest.files.filter(file=>file.parts))await access(path.join(directory,file.path));
}));


test('Оставленная другим Docker PID namespace блокировка восстанавливается после истечения heartbeat',async()=>fixture(async({first,directory})=>{
    await first.run();const lock=path.join(directory,'.bundle-managed/activation.lock');await mkdir(lock);
    const owner=path.join(lock,'owner.json');await writeFile(owner,JSON.stringify({pid:process.pid,namespace:'old-container-pid-namespace',token:'old-owner'}));
    const past=new Date(Date.now()-60000);await utimes(owner,past,past);
    await first.run();await assert.rejects(access(lock));await first.run({verifyOnly:true});
}));


test('Пустая и брошенная до публикации owner блокировка не мешают следующему запуску',async()=>fixture(async({first,directory})=>{
    await first.run();const lock=path.join(directory,'.bundle-managed/activation.lock');
    await mkdir(lock);await first.run();await assert.rejects(access(lock));
    await mkdir(lock);await writeFile(path.join(lock,'.managed-interrupted'),'partial owner');
    const past=new Date(Date.now()-60000);await utimes(lock,past,past);await first.run();await assert.rejects(access(lock));
    const abandoned=(await readdir(path.join(directory,'.bundle-managed'))).find(name=>name.startsWith('.abandoned-lock-'));
    assert.equal(await readFile(path.join(directory,'.bundle-managed',abandoned,'.managed-interrupted'),'utf8'),'partial owner');
    await first.run({verifyOnly:true});
}));

for(const phase of ['before','after'])test(`Убитый процесс ${phase==='before'?'до':'после'} публикации блокировки допускает повтор`,async()=>fixture(async({root,directory,first,contents})=>{
    await first.run();const before=await contents(),tags=path.join(root,'tags.json');await writeFile(tags,JSON.stringify(first.tags));
    const module=fileURLToPath(new URL('../models/bundle-managed.mjs',import.meta.url));
    const result=spawnSync(process.execPath,['--input-type=module','-e',`
        import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';
        const rename=fs.rename;
        fs.rename=async(source,target)=>{
            if(target.endsWith('/activation.lock')) {
                if(process.argv[4]==='after')await rename(source,target);
                process.exit(84);
            }
            return rename(source,target);
        };
        syncBuiltinESMExports();
        const {activateManagedModelBundle}=await import(process.argv[1]);
        await activateManagedModelBundle(process.argv[2],JSON.parse(await fs.readFile(process.argv[3],'utf8')));
    `,module,directory,tags,phase],{encoding:'utf8',timeout:5000});
    assert.equal(result.status,84,result.stderr);assert.deepEqual(await contents(),before);
    const lock=path.join(directory,'.bundle-managed/activation.lock');
    if(phase==='before')await assert.rejects(access(lock));
    else {const owner=JSON.parse(await readFile(path.join(lock,'owner.json'),'utf8'));assert.ok(owner.token);}
    await first.run();await first.run({verifyOnly:true});await assert.rejects(access(lock));assert.deepEqual(await contents(),before);
}));
