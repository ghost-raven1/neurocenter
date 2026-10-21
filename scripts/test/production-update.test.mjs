import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,stat,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {applicationServices} from '../production/compose-client.mjs';
import {validateUpdatePlan,assertMigrationPrefix,preflightUpdate,updateProduction} from '../production/update.mjs';
import {pauseBudget} from '../production/recovery.mjs';
import {digestFile,inventory} from '../production/recovery-files.mjs';
import {verifyBackup} from '../production/recovery-manifest.mjs';
import {ensureModelCredentialKey,modelCredentialIdentity} from '../workspace/model-credentials.mjs';

const image=letter=>'sha256:'+letter.repeat(64);
const source=Object.fromEntries(applicationServices.map(service=>[service,image('a')]));
const target=Object.fromEntries(applicationServices.map((service,index)=>[service,image((index+2).toString(16))]));
const migration={version:1,name:'История установки',checksum:'c'.repeat(64)};
const baseline={version:0,name:'Полная исходная схема',checksum:'b'.repeat(64)};
const catalogMigrations=[baseline,migration];
const schemaServices=['catalog-service','feature-flags-service','rag-sync-service'];
const imageManifests=()=>({'catalog-service':catalogMigrations,'feature-flags-service':[migration],'rag-sync-service':[{...migration,scope:'data',version:'project-generations-1'}]});
const digest=value=>createHash('sha256').update(value).digest('hex');
async function fixture(action){
    const directory=await realpath(await mkdtemp(path.join(tmpdir(),'nc-update-')));const calls=[],readOnlyCalls=[];
    const before="NEUROCENTER_RELEASE='old'\nRAG_MAX_QUOTA_BYTES='4096'\nPANEL_URL='https://panel.example.test'\n";
    await writeFile(path.join(directory,'.env'),before,{mode:0o600});
    const report={format:'neurocenter-update-rehearsal-v1',passed:true,copyOfData:true,settingsPreserved:true,repeatSafe:true,restoreVerified:true,sourceImages:source,targetImages:target,postgresImage:image('d')};
    const raw=JSON.stringify(report);const rehearsalFile=path.join(directory,'rehearsal.json');await writeFile(rehearsalFile,raw,{mode:0o600});
    const plan={format:'neurocenter-update-v1',id:'test-update',sourceRelease:'old',targetRelease:'new',sourceImages:source,targetImages:target,postgresImage:image('d'),
        rollback:'restore-new-project',migrationCompatibility:'restore-required',catalogMigrations,rehearsalSha256:digest(raw),maxPauseMs:60000};
    const options={directory,projectName:'nc-update-test',plan,rehearsalFile,backupDestination:path.join(directory,'snapshot'),execute:true};
    let live=source;let failStart=false;let beforeDeploy=async()=>{};let backupError;let alteredTarget=false;let storedKeyIds;let failSchema;let applied=[migration];let ledgerPresent=true;const manifests=imageManifests();
    const states=()=>[...applicationServices,'postgres'].map(service=>({Id:service,Image:service==='postgres'?image('d'):live[service],
        Config:{Labels:{'com.docker.compose.service':service}},State:{Running:true,Health:{Status:'healthy'}}}));
    const deps={
        composeClient:config=>({...config,run:async(args,settings)=>{
            if(args.at(-1)==='check'){readOnlyCalls.push({command:args,config,settings});return JSON.stringify({ok:true,ready:false,existingSchema:true,applied:[1],pending:[0]});}
            calls.push({command:args,config,settings});
            if(args.at(-1)==='migrate'){if(args.includes(failSchema))throw Error('отказ миграции схемы');return JSON.stringify({ok:true,ready:true,existingSchema:true,applied:[0,1],pending:[]});}
            if(args[0]==='up'){if(failStart){live=target;throw new Error('отказ миграции');}live=target;}return '';
        }}),
        composeConfiguration:async client=>({services:Object.fromEntries([...applicationServices,'postgres'].map(service=>[service,{image:service==='postgres'?'postgres':(client.release?'target':'source')+':'+service,environment:{QUOTA:alteredTarget&&client.release?'changed':'kept'}}])),volumes:{postgres:{name:'stable-postgres'}},secrets:{model_credential_key:{file:path.join(directory,'secrets/model_credential_key')}}}),
        serviceImageIds:async config=>config.services.frontend.image.startsWith('target')?target:source,
        containers:async()=>states(),
        docker:async(args,settings)=>{
            if(args[0]==='run'){readOnlyCalls.push({command:args,settings});return JSON.stringify(manifests[schemaServices.find(service=>args.includes(target[service]))]);}
            if(settings?.input?.includes('to_regclass')&&settings.input.includes('catalog_schema_migrations'))return ledgerPresent?'t':'f';
            return args[0]==='image'?JSON.stringify([{Id:image('d')}]):settings?.input?.includes('to_regclass')?(storedKeyIds===undefined?'f':'t'):settings?.input?.includes("credential->>'keyId'")?JSON.stringify(storedKeyIds):JSON.stringify(applied);
        },
        withBackup:async(config,hooks)=>{calls.push({backup:true,config});await hooks.beforePause();if(backupError){throw backupError;}await beforeDeploy();calls.push({backupReady:true});return hooks.afterBackup({ok:true,sha256:'e'.repeat(64),destination:config.destination},{remainingMs:()=>60000});},
    };
    try{await action({directory,before,options,plan,deps,calls,readOnlyCalls,setLive:value=>{live=value;},failStart:()=>{failStart=true;},failSchema:service=>{failSchema=service;},setLedger:value=>{ledgerPresent=value;},setApplied:value=>{applied=value;},setManifest:(service,value)=>{manifests[service]=value;},beforeDeploy:fn=>{beforeDeploy=fn;},failBackup:()=>{backupError=new Error('копия не создана');},alterTarget:()=>{alteredTarget=true;},setStoredKeyIds:ids=>{storedKeyIds=ids;}});}
    finally{await rm(directory,{recursive:true,force:true});}
}

test('Preflight проверяет план без остановки, копии и изменения настроек',async()=>fixture(async f=>{
    const checked=await preflightUpdate(f.options,f.deps);assert.equal(checked.dryRun,true);assert.deepEqual(f.calls,[]);assert.equal(await readFile(path.join(f.directory,'.env'),'utf8'),f.before);
    await assert.rejects(stat(path.join(f.directory,'updates')),{code:'ENOENT'});
    assert.deepEqual(checked.modelCredentialKey,{required:true,keyId:null});await assert.rejects(stat(path.join(f.directory,'secrets')),{code:'ENOENT'});
    assert.equal(f.readOnlyCalls.length,6);assert.deepEqual(checked.schemaManifests,imageManifests());
    assert.deepEqual(f.readOnlyCalls.filter(row=>row.command.at(-1)==='check').map(row=>row.command.at(-3)),schemaServices);
    for(const check of f.readOnlyCalls.filter(row=>row.command.at(-1)==='check'))await assert.rejects(stat(check.config.files.at(-1)),{code:'ENOENT'});
}));
test('Caller не подменяет полный manifest точного нового образа своим валидным планом',async()=>fixture(async f=>{
    f.setManifest('catalog-service',[{...baseline,checksum:'f'.repeat(64)},migration]);
    await assert.rejects(preflightUpdate(f.options,f.deps),/плана расходится/);assert.deepEqual(f.calls,[]);
    assert.ok(!f.readOnlyCalls.some(row=>row.command.at(-1)==='check'));
}));
test('Старая runtime-схема без migration ledger проходит только readonly preflight, без implicit repair',async()=>fixture(async f=>{
    f.setLedger(false);
    const original=f.deps.docker;f.deps.docker=async(args,options)=>{
        if(options?.input?.startsWith('SELECT coalesce(json_agg(json_build_object'))throw Error('missing ledger must not be queried');
        return original(args,options);
    };
    const result=await preflightUpdate(f.options,f.deps);assert.equal(result.dryRun,true);assert.equal(result.schemas['catalog-service'].existingSchema,true);
    assert.deepEqual(f.calls,[]);assert.equal(await readFile(path.join(f.directory,'.env'),'utf8'),f.before);
}));
test('Неполный manifest флагов/RAG не допускает update только на основании каталожного журнала',async()=>fixture(async f=>{
    f.setManifest('rag-sync-service',[]);
    await assert.rejects(updateProduction(f.options,f.deps),/опись миграций rag-sync-service/);assert.deepEqual(f.calls,[]);
}));
test('Проверка чужого checksum текущей истории не выполняет DDL и не создаёт копию',async()=>fixture(async f=>{
    f.setApplied([{...migration,checksum:'f'.repeat(64)}]);
    await assert.rejects(updateProduction(f.options,f.deps),/История миграций несовместима/);assert.deepEqual(f.calls,[]);
}));
test('Отказ read-only check останавливает update до копии и любых migrate',async()=>fixture(async f=>{
    const original=f.deps.composeClient;
    f.deps.composeClient=config=>{const client=original(config);return {...client,run:async(args,...options)=>{
        if(args.at(-1)==='check'&&args.includes('feature-flags-service'))throw Error('fixture incompatible flags history');
        return client.run(args,...options);
    }};};
    await assert.rejects(updateProduction(f.options,f.deps),/incompatible flags history/);assert.deepEqual(f.calls,[]);
}));
test('Первичное обновление готовит постоянный ключ до паузы; повтор сохраняет его identity',async()=>fixture(async f=>{
    let beforeStart;f.beforeDeploy(async()=>{beforeStart=await modelCredentialIdentity(f.directory);});
    const result=await updateProduction(f.options,f.deps),filename=path.join(f.directory,'secrets/model_credential_key'),before=await readFile(filename);
    assert.equal(result.modelCredentialKeyId,beforeStart.keyId);assert.ok(!JSON.stringify(result).includes(before.toString().trim()));
    await updateProduction(f.options,f.deps);assert.deepEqual(await readFile(filename),before);
}));
test('Отсутствующий ключ с существующими stored credentials блокирует update до копии и запуска',async()=>fixture(async f=>{
    f.setStoredKeyIds(['a'.repeat(24)]);await assert.rejects(updateProduction(f.options,f.deps),/Восстановите исходные/);
    assert.deepEqual(f.calls,[]);await assert.rejects(stat(path.join(f.directory,'secrets/model_credential_key')),{code:'ENOENT'});
}));
test('Неправильный корректный key file блокирует update и сохраняется без скрытой ротации',async()=>fixture(async f=>{
    const filename=await ensureModelCredentialKey(f.directory),before=await readFile(filename);f.setStoredKeyIds(['a'.repeat(24)]);
    await assert.rejects(updateProduction(f.options,f.deps),/Восстановите исходные/);assert.deepEqual(await readFile(filename),before);assert.deepEqual(f.calls,[]);
}));
test('Потеря ключа во время копии останавливает update до target up',async()=>fixture(async f=>{
    const filename=await ensureModelCredentialKey(f.directory);f.beforeDeploy(()=>rm(filename));
    await assert.rejects(updateProduction(f.options,f.deps),/автоматическая замена запрещена/);
    assert.equal(f.calls.some(row=>row.command?.[0]==='up'),false);await assert.rejects(stat(filename),{code:'ENOENT'});assert.equal(await readFile(path.join(f.directory,'.env'),'utf8'),f.before);
}));
test('Подмена ключа и marker во время копии обнаруживается по identity квитанции',async()=>fixture(async f=>{
    const filename=await ensureModelCredentialKey(f.directory);f.beforeDeploy(async()=>{await rm(filename);await rm(filename+'.id');await ensureModelCredentialKey(f.directory);});
    await assert.rejects(updateProduction(f.options,f.deps),/Ключ шифрования моделей изменился во время копирования/);
    assert.equal(f.calls.some(row=>row.command?.[0]==='up'),false);
}));
test('Повтор завершённого update с утраченным ключом не создаёт замену и не запускает миграции',async()=>fixture(async f=>{
    await updateProduction(f.options,f.deps);const count=f.calls.length,filename=path.join(f.directory,'secrets/model_credential_key');await rm(filename);
    await assert.rejects(updateProduction(f.options,f.deps),/автоматическая замена запрещена/);assert.equal(f.calls.length,count);await assert.rejects(stat(filename),{code:'ENOENT'});
}));
test('Новый релиз начинается только после копии; настройки и исходный env сохраняются',async()=>fixture(async f=>{
    const result=await updateProduction(f.options,f.deps);assert.equal(result.state,'completed');assert.equal(result.backup.sha256,'e'.repeat(64));
    assert.equal(f.calls[0].backup,true);assert.equal(f.calls[0].config.maxPauseMs,60000);
    const up=f.calls.find(row=>row.command?.[0]==='up');assert.ok(up.command.includes('--no-build'));assert.ok(up.command.includes('never'));assert.equal(up.settings.timeout,60000);
    assert.ok(up.command.includes('feature-flags-service'));
    const migrations=f.calls.filter(row=>row.command?.at(-1)==='migrate');assert.deepEqual(migrations.map(row=>row.command.at(-3)),schemaServices);
    assert.ok(f.calls.findIndex(row=>row.backupReady)<f.calls.indexOf(migrations[0]));assert.ok(f.calls.indexOf(migrations.at(-1))<f.calls.indexOf(up));
    assert.ok(f.calls.findIndex(row=>row.backupReady)<f.calls.indexOf(up));
    const pinned=JSON.parse(await readFile(up.config.files.at(-1),'utf8'));assert.equal(pinned.services['catalog-service'].image,target['catalog-service']);
    assert.equal(pinned.services['feature-flags-service'].image,target['feature-flags-service']);
    assert.deepEqual(result.schemaManifests,imageManifests());assert.ok(schemaServices.every(service=>result.schemas[service].ready));
    assert.equal(await readFile(path.join(f.directory,'updates/test-update.env.before'),'utf8'),f.before);
    assert.equal(await readFile(path.join(f.directory,'.env'),'utf8'),f.before.replace("'old'","'new'"));
    assert.equal((await stat(path.join(f.directory,'updates/test-update.json'))).mode&0o777,0o600);
}));
test('Повтор успешной операции не создаёт копию и не повторяет запуск',async()=>fixture(async f=>{
    await updateProduction(f.options,f.deps);const count=f.calls.length;const repeated=await updateProduction(f.options,f.deps);
    assert.equal(repeated.repeated,true);assert.equal(f.calls.length,count);
}));
for(const service of schemaServices)test('Отказ migrate '+service+' сохраняет копию и блокирует запуск приложений',async()=>fixture(async f=>{
    f.failSchema(service);await assert.rejects(updateProduction(f.options,f.deps),/отказ миграции схемы/);
    assert.ok(f.calls.some(row=>row.backupReady));assert.ok(!f.calls.some(row=>row.command?.[0]==='up'));
    assert.deepEqual(f.calls.filter(row=>row.command?.at(-1)==='migrate').map(row=>row.command.at(-3)),schemaServices.slice(0,schemaServices.indexOf(service)+1));
    const receipt=JSON.parse(await readFile(path.join(f.directory,'updates/test-update.json'),'utf8'));
    assert.equal(receipt.state,'failed');assert.equal(receipt.failurePhase,'applying');assert.ok(receipt.backup.sha256);
    const count=f.calls.length;await assert.rejects(updateProduction(f.options,f.deps),/повтор запрещён/);assert.equal(f.calls.length,count);
}));
test('Повтор прерванной операции не исполняет уже начатые миграции',async()=>fixture(async f=>{
    f.failStart();await assert.rejects(updateProduction(f.options,f.deps),/миграции/);
    assert.equal(f.calls.at(-1).command[0],'stop');assert.equal(await readFile(path.join(f.directory,'.env'),'utf8'),f.before);
    const receipt=JSON.parse(await readFile(path.join(f.directory,'updates/test-update.json'),'utf8'));assert.equal(receipt.state,'failed');assert.equal(receipt.failurePhase,'applying');assert.ok(receipt.backup.sha256);
    const count=f.calls.length;await assert.rejects(updateProduction(f.options,f.deps),/повтор запрещён/);assert.equal(f.calls.length,count);
}));
test('После отказа миграции остановка и failed-квитанция завершаются до снятия общей блокировки',async()=>fixture(async f=>{
    f.failStart();const events=[];let atUnlock;
    const client=f.deps.composeClient;f.deps.composeClient=options=>{const value=client(options);return {...value,run:async(args,...rest)=>{if(args[0]==='stop'){events.push('stop');}return value.run(args,...rest);}};};
    const backup=f.deps.withBackup;f.deps.withBackup=async(...args)=>{try{return await backup(...args);}finally{events.push('unlock');atUnlock=JSON.parse(await readFile(path.join(f.directory,'updates/test-update.json'),'utf8'));}};
    await assert.rejects(updateProduction(f.options,f.deps),/миграции/);
    assert.deepEqual(events,['stop','unlock']);assert.equal(atUnlock.state,'failed');assert.equal(atUnlock.failurePhase,'applying');assert.ok(atUnlock.backup.sha256);
    const calls=f.calls.length;await assert.rejects(updateProduction(f.options,f.deps),/повтор запрещён/);assert.equal(f.calls.length,calls);
}));
test('Неудачная остановка фиксируется под блокировкой и не повторяется после её освобождения',async()=>fixture(async f=>{
    f.failStart();let stops=0;let atUnlock;
    const client=f.deps.composeClient;f.deps.composeClient=options=>{const value=client(options);return {...value,run:async(args,...rest)=>{if(args[0]==='stop'){stops++;throw new Error('Docker недоступен при stop');}return value.run(args,...rest);}};};
    const backup=f.deps.withBackup;f.deps.withBackup=async(...args)=>{try{return await backup(...args);}finally{atUnlock=JSON.parse(await readFile(path.join(f.directory,'updates/test-update.json'),'utf8'));}};
    await assert.rejects(updateProduction(f.options,f.deps),/миграции/);assert.equal(stops,1);
    assert.equal(atUnlock.stopFailed,true);assert.equal(atUnlock.state,'failed');assert.equal(atUnlock.failurePhase,'applying');
}));
test('Ошибка освобождения блокировки после успеха не останавливает новый релиз и не стирает completed',async()=>fixture(async f=>{
    const backup=f.deps.withBackup;f.deps.withBackup=async(...args)=>{await backup(...args);throw new Error('не подтверждено освобождение блокировки');};
    await assert.rejects(updateProduction(f.options,f.deps),/освобождение блокировки/);
    assert.equal(f.calls.some(row=>row.command?.[0]==='stop'),false);
    const receipt=JSON.parse(await readFile(path.join(f.directory,'updates/test-update.json'),'utf8'));assert.equal(receipt.state,'completed');
    const calls=f.calls.length;assert.equal((await updateProduction(f.options,f.deps)).repeated,true);assert.equal(f.calls.length,calls);
}));
test('SIGTERM во время applying сохраняет комплект и запрещает повтор миграций после перезапуска',{timeout:10000},async()=>fixture(async f=>{
    const child=spawn(process.execPath,[fileURLToPath(new URL('./production-update-interruption.fixture.mjs',import.meta.url))],{stdio:['ignore','ignore','pipe','ipc']});
    let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk;});
    try{
        const received=Promise.race([once(child,'message'),once(child,'exit').then(()=>{throw new Error('Fixture завершился до applying: '+stderr);})]);child.send(f.options);const [message]=await received;
        assert.deepEqual(message,{phase:'applying'},stderr);
        const closed=once(child,'close');child.kill('SIGTERM');const [code,signal]=await closed;assert.equal(code,null);assert.equal(signal,'SIGTERM');
        const receipt=JSON.parse(await readFile(path.join(f.directory,'updates/test-update.json'),'utf8'));assert.equal(receipt.state,'applying');
        const manifest=await verifyBackup(receipt.backup.destination,receipt.backup.sha256);assert.deepEqual(manifest.images,f.plan.sourceImages);
        assert.equal(await readFile(path.join(f.directory,'.env'),'utf8'),f.before);
        assert.equal(await readFile(path.join(f.directory,'updates/test-update.env.before'),'utf8'),f.before);
        await assert.rejects(updateProduction(f.options,f.deps),/повтор запрещён/);assert.deepEqual(f.calls,[]);
    }finally{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await once(child,'close');}}
}));
test('Ошибка копии останавливает обновление до запуска новых образов',async()=>fixture(async f=>{
    f.failBackup();await assert.rejects(updateProduction(f.options,f.deps),/копия/);
    assert.ok(f.calls.filter(row=>row.command).every(row=>row.command.includes('--download-only')));assert.equal(await readFile(path.join(f.directory,'.env'),'utf8'),f.before);
}));
test('Конфликт настройки после копии блокирует миграции и сохраняет чужое изменение',async()=>fixture(async f=>{
    f.beforeDeploy(()=>writeFile(path.join(f.directory,'.env'),f.before+"CUSTOM='сохранить'\n"));
    await assert.rejects(updateProduction(f.options,f.deps),/Настройки изменены/);assert.equal(f.calls.some(row=>row.command?.[0]==='up'),false);
    assert.ok((await readFile(path.join(f.directory,'.env'),'utf8')).includes('сохранить'));
}));
test('Повтор чужого ID операции и незаметный дрейф образов отклоняются',async()=>fixture(async f=>{
    await updateProduction(f.options,f.deps);f.setLive(source);await assert.rejects(updateProduction(f.options,f.deps),/образ сервиса/);
    f.plan.maxPauseMs=120000;await assert.rejects(updateProduction(f.options,f.deps),/другим планом/);
}));
test('Изменение томов или параметров в новом Compose не допускается',async()=>fixture(async f=>{
    f.alterTarget();await assert.rejects(preflightUpdate(f.options,f.deps),/настройки, секреты или тома/);assert.deepEqual(f.calls,[]);
}));
test('Неверная квитанция репетиции не останавливает рабочий стек',async()=>fixture(async f=>{
    f.plan.rehearsalSha256='0'.repeat(64);await assert.rejects(updateProduction(f.options,f.deps),/SHA256/);assert.deepEqual(f.calls,[]);
}));
test('Неуспешная репетиция не становится разрешением обновления после пересчёта SHA',async()=>fixture(async f=>{
    const report=JSON.parse(await readFile(f.options.rehearsalFile,'utf8'));report.settingsPreserved=false;const raw=JSON.stringify(report);await writeFile(f.options.rehearsalFile,raw);f.plan.rehearsalSha256=digest(raw);
    await assert.rejects(updateProduction(f.options,f.deps),/успешная репетиция/);
}));
test('Несовместимая история, изменённый checksum и понижение схемы отклоняются',()=>{
    assertMigrationPrefix([baseline,migration],[baseline,migration,{...migration,version:2}]);
    for(const applied of [[{...migration,checksum:'f'.repeat(64)}],[migration,{...migration,version:2}],[{...migration,version:2}]]){assert.throws(()=>assertMigrationPrefix(applied,[baseline,migration]),/несовместима/);}
});
test('Полная цепочка начинается с baseline0 и принимает только точную историческую 1–5 без baseline',()=>{
    const baseline={...migration,version:0,name:'full-catalog-baseline'};
    const historical=Array.from({length:5},(_,index)=>({...migration,version:index+1,name:'historical-'+(index+1)}));
    const complete=[baseline,...historical,{...migration,version:6,name:'catalog-finalization'}];
    assert.doesNotThrow(()=>assertMigrationPrefix([],complete));
    assert.doesNotThrow(()=>assertMigrationPrefix(historical,complete));
    assert.doesNotThrow(()=>assertMigrationPrefix(complete,complete));
    for(const applied of [[...historical,{...migration,version:6,name:'catalog-finalization'}],[{...historical[0],checksum:'f'.repeat(64)}],historical.slice(1)]){
        assert.throws(()=>assertMigrationPrefix(applied,complete),/несовместима/);
    }
    assert.throws(()=>assertMigrationPrefix([],historical),/опись миграций/);
});
test('Автоматический downgrade и неизвестная совместимость не разрешаются планом',async()=>fixture(async f=>{
    for(const changed of [{rollback:'image-downgrade'},{targetRelease:'latest'},{migrationCompatibility:'unknown'},{maxPauseMs:0},{targetImages:{}}]){assert.throws(()=>validateUpdatePlan({...f.plan,...changed}));}
}));
test('Пауза учитывает время остановки и выдаёт остаток без фонового таймера',()=>{
    let now=100;const remaining=pauseBudget(45000,()=>now);assert.equal(remaining(),45000);now+=44000;assert.equal(remaining(),1000);now+=1000;
    assert.throws(remaining,error=>error.code==='MAINTENANCE_PAUSE_EXCEEDED');assert.throws(()=>pauseBudget(0));
});
test('Прерывание SHA и описи дожидается закрытия файлов',async()=>{
    const directory=await mkdtemp(path.join(tmpdir(),'nc-update-deadline-'));const filename=path.join(directory,'large');
    try{await writeFile(filename,Buffer.alloc(256*1024));let checked=0;
        await assert.rejects(digestFile(filename,{checkDeadline:()=>{checked++;throw new Error('дедлайн');}}),/дедлайн/);assert.ok(checked>0);
        await assert.rejects(inventory(directory,{checkDeadline:()=>{throw new Error('дедлайн');}}),/дедлайн/);
        await rm(filename);assert.deepEqual(await inventory(directory),[]);
    }finally{await rm(directory,{recursive:true,force:true});}
});
