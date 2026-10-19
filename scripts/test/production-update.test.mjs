import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {applicationServices} from '../production/compose-client.mjs';
import {runCatalogSync} from '../production/sync-catalog.mjs';
import {runModelBundleSync} from '../production/sync-models.mjs';
import {validateUpdatePlan,assertMigrationPrefix,preflightUpdate,updateProduction} from '../production/update.mjs';
import {pauseBudget} from '../production/recovery.mjs';
import {digestFile,inventory} from '../production/recovery-files.mjs';
import {verifyBackup} from '../production/recovery-manifest.mjs';

const image=letter=>'sha256:'+letter.repeat(64);
const source=Object.fromEntries(applicationServices.map(service=>[service,image('a')]));
const target=Object.fromEntries(applicationServices.map(service=>[service,image('b')]));
const migration={version:1,name:'История установки',checksum:'c'.repeat(64)};
const digest=value=>createHash('sha256').update(value).digest('hex');
async function fixture(action){
    const directory=await mkdtemp(path.join(tmpdir(),'nc-update-'));const calls=[];
    const before="NEUROCENTER_RELEASE='old'\nRAG_MAX_QUOTA_BYTES='4096'\nPANEL_URL='https://panel.example.test'\n";
    await writeFile(path.join(directory,'.env'),before,{mode:0o600});
    const report={format:'neurocenter-update-rehearsal-v1',passed:true,copyOfData:true,settingsPreserved:true,repeatSafe:true,restoreVerified:true,sourceImages:source,targetImages:target,postgresImage:image('d')};
    const raw=JSON.stringify(report);const rehearsalFile=path.join(directory,'rehearsal.json');await writeFile(rehearsalFile,raw,{mode:0o600});
    const plan={format:'neurocenter-update-v1',id:'test-update',sourceRelease:'old',targetRelease:'new',sourceImages:source,targetImages:target,postgresImage:image('d'),
        rollback:'restore-new-project',migrationCompatibility:'restore-required',catalogMigrations:[migration],rehearsalSha256:digest(raw),maxPauseMs:60000};
    const options={directory,projectName:'nc-update-test',plan,rehearsalFile,backupDestination:path.join(directory,'snapshot'),execute:true};
    let live=source;let failStart=false;let beforeDeploy=async()=>{};let backupError;let alteredTarget=false;let catalogErrorPhase;let modelErrorPhase;
    const states=()=>[...applicationServices,'postgres'].map(service=>({Id:service,Image:service==='postgres'?image('d'):live[service],
        Config:{Labels:{'com.docker.compose.service':service}},State:{Running:true,Health:{Status:'healthy'}}}));
    const deps={
        runCatalogSync:(client,options)=>runCatalogSync(client,options,{docker:async()=>''}),
        runModelBundleSync:(client,options)=>runModelBundleSync(client,options,{docker:async()=>''}),
        composeClient:config=>({...config,run:async(args,settings)=>{
            calls.push({command:args,config,settings});
            if(args[0]==='run'){
                if(args.includes('/tools/scripts/models/bundle-cli.mjs')){
                    if(modelErrorPhase===(args.includes('--download-only')?'download':'sync')){throw new Error('комплект моделей недоступен');}
                    return JSON.stringify({ok:true,downloadOnly:args.includes('--download-only'),verifyOnly:false,models:2,files:9,bytes:4400000000});
                }
                if(catalogErrorPhase===(args.includes('--download-only')?'download':'sync')){throw new Error('каталог недоступен');}
                return JSON.stringify({ok:true,dryRun:false,downloadOnly:args.includes('--download-only'),artifacts:0,tools:[]});
            }
            if(args[0]==='up'){if(failStart){live=target;throw new Error('отказ миграции');}live=target;}return '';
        }}),
        composeConfiguration:async client=>({services:Object.fromEntries([...applicationServices,'postgres','model-volume-init'].map(service=>[service,{image:service==='postgres'?'postgres':(client.release?'target':'source')+':'+service,environment:{QUOTA:alteredTarget&&client.release?'changed':'kept'}}])),volumes:{postgres:{name:'stable-postgres'}}}),
        serviceImageIds:async config=>config.services.frontend.image.startsWith('target')?target:source,
        containers:async()=>states(),
        docker:async args=>args[0]==='image'?JSON.stringify([{Id:image('d')}]):JSON.stringify([migration]),
        withBackup:async(config,hooks)=>{calls.push({backup:true,config});await hooks.beforePause();if(backupError){throw backupError;}await beforeDeploy();calls.push({backupReady:true});return hooks.afterBackup({ok:true,sha256:'e'.repeat(64),destination:config.destination},{remainingMs:()=>60000});},
    };
    try{await action({directory,before,options,plan,deps,calls,setLive:value=>{live=value;},failStart:()=>{failStart=true;},beforeDeploy:fn=>{beforeDeploy=fn;},failBackup:()=>{backupError=new Error('копия не создана');},alterTarget:()=>{alteredTarget=true;},failCatalog:(phase='download')=>{catalogErrorPhase=phase;},failModels:(phase='download')=>{modelErrorPhase=phase;}});}
    finally{await rm(directory,{recursive:true,force:true});}
}

test('Preflight проверяет план без остановки, копии и изменения настроек',async()=>fixture(async f=>{
    const checked=await preflightUpdate(f.options,f.deps);assert.equal(checked.dryRun,true);assert.deepEqual(f.calls,[]);assert.equal(await readFile(path.join(f.directory,'.env'),'utf8'),f.before);
    await assert.rejects(stat(path.join(f.directory,'updates')),{code:'ENOENT'});
}));
test('Новый релиз начинается только после копии; настройки и исходный env сохраняются',async()=>fixture(async f=>{
    const result=await updateProduction(f.options,f.deps);assert.equal(result.state,'completed');assert.equal(result.backup.sha256,'e'.repeat(64));
    assert.equal(f.calls[0].backup,true);assert.equal(f.calls[0].config.maxPauseMs,60000);
    const up=f.calls.find(row=>row.command?.[0]==='up');assert.ok(up.command.includes('--no-build'));assert.ok(up.command.includes('never'));assert.equal(up.settings.timeout,60000);
    assert.ok(up.command.includes('feature-flags-service'));
    const sync=f.calls.filter(row=>row.command?.includes('dist/builtin-catalog/sync.cli.js'));assert.equal(sync.length,2);
    assert.ok(sync[0].command.includes('--download-only'));assert.ok(!sync[1].command.includes('--download-only'));
    assert.equal(sync[1].settings.timeout,60000);
    const copied=f.calls.findIndex(row=>row.backupReady);assert.ok(f.calls.indexOf(sync[0])<copied&&copied<f.calls.indexOf(sync[1]));
    assert.ok(f.calls.indexOf(sync[1])<f.calls.indexOf(up));assert.ok(result.catalog.ok);
    const models=f.calls.filter(row=>row.command?.includes('/tools/scripts/models/bundle-cli.mjs'));assert.equal(models.length,2);
    assert.ok(models[0].command.includes('--download-only'));assert.ok(!models[1].command.includes('--download-only'));
    assert.ok(f.calls.indexOf(models[0])<copied&&copied<f.calls.indexOf(models[1]));
    assert.equal(models[1].settings.timeout,60000);assert.ok(f.calls.indexOf(models[1])<f.calls.indexOf(up));
    assert.equal(result.models.models,2);
    const pinned=JSON.parse(await readFile(up.config.files.at(-1),'utf8'));assert.equal(pinned.services['catalog-service'].image,image('b'));
    assert.equal(pinned.services['feature-flags-service'].image,image('b'));
    assert.equal(pinned.services['model-volume-init'].image,image('b'));
    assert.equal(await readFile(path.join(f.directory,'updates/test-update.env.before'),'utf8'),f.before);
    assert.equal(await readFile(path.join(f.directory,'.env'),'utf8'),f.before.replace("'old'","'new'"));
    assert.equal((await stat(path.join(f.directory,'updates/test-update.json'))).mode&0o777,0o600);
}));
test('Повтор успешной операции не создаёт копию и не повторяет запуск',async()=>fixture(async f=>{
    await updateProduction(f.options,f.deps);const count=f.calls.length;const repeated=await updateProduction(f.options,f.deps);
    assert.equal(repeated.repeated,true);assert.equal(f.calls.length,count);
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
test('Ошибка загрузки каталога до паузы не запускает новый релиз и сохраняет настройки',async()=>fixture(async f=>{
    f.failCatalog();await assert.rejects(updateProduction(f.options,f.deps),/каталог/);
    assert.equal(f.calls.filter(row=>row.command?.[0]==='run').length,1);
    assert.equal(f.calls.some(row=>['up','stop'].includes(row.command?.[0])),false);
    assert.equal(await readFile(path.join(f.directory,'.env'),'utf8'),f.before);
}));
test('Ошибка публикации после копии останавливает rollout и сохраняет комплект для восстановления',async()=>fixture(async f=>{
    f.failCatalog('sync');await assert.rejects(updateProduction(f.options,f.deps),/каталог/);
    assert.equal(f.calls.some(row=>row.command?.[0]==='up'),false);
    assert.equal(f.calls.at(-1).command[0],'stop');
    const receipt=JSON.parse(await readFile(path.join(f.directory,'updates/test-update.json'),'utf8'));
    assert.equal(receipt.state,'failed');assert.equal(receipt.failurePhase,'applying');assert.ok(receipt.backup.sha256);
    assert.equal(await readFile(path.join(f.directory,'.env'),'utf8'),f.before);
}));
test('Ошибка загрузки моделей до паузы сохраняет работающий релиз без остановки',async()=>fixture(async f=>{
    f.failModels();await assert.rejects(updateProduction(f.options,f.deps),/моделей/);
    assert.equal(f.calls.some(row=>['up','stop'].includes(row.command?.[0])),false);
    assert.equal(f.calls.some(row=>row.backupReady),false);
    assert.equal(await readFile(path.join(f.directory,'.env'),'utf8'),f.before);
}));
test('Ошибка активации моделей после копии останавливает rollout и сохраняет прежние настройки',async()=>fixture(async f=>{
    f.failModels('sync');await assert.rejects(updateProduction(f.options,f.deps),/моделей/);
    assert.equal(f.calls.some(row=>row.command?.[0]==='up'),false);
    assert.equal(f.calls.at(-1).command[0],'stop');
    const receipt=JSON.parse(await readFile(path.join(f.directory,'updates/test-update.json'),'utf8'));
    assert.equal(receipt.state,'failed');assert.ok(receipt.backup.sha256);assert.ok(receipt.modelDownload.ok);
    assert.equal(await readFile(path.join(f.directory,'.env'),'utf8'),f.before);
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
    assertMigrationPrefix([migration],[migration,{...migration,version:2}]);
    for(const applied of [[{...migration,checksum:'f'.repeat(64)}],[migration,{...migration,version:2}],[{...migration,version:2}]]){assert.throws(()=>assertMigrationPrefix(applied,[migration]),/несовместима/);}
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
