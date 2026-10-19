import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {applicationServices} from '../production/compose-client.mjs';
import {backupProduction,withQuiescedProductionBackup,volumeTransfer} from '../production/recovery.mjs';
import {volumeKeys} from '../production/recovery-files.mjs';
import {verifyBackup} from '../production/recovery-manifest.mjs';

const image='sha256:'+'a'.repeat(64);
async function fixture(action){
    const root=await mkdtemp(path.join(tmpdir(),'nc-backup-lifecycle-'));const events=[];let running=true;let copy=async()=>{};
    const names=Object.fromEntries(['postgres',...volumeKeys].map(key=>[key,'fixture-'+key]));
    const databases=['catalog','rag'].map(name=>({name,owner:name==='catalog'?'nc_catalog':'nc_rag',encoding:'UTF8',collate:'C.UTF-8',ctype:'C.UTF-8',file:'databases/'+name+'.dump'}));
    const mount=(key,destination)=>({Source:'/docker/'+key,Type:'volume',Name:names[key],Destination:destination});
    const mounts={
        'skills-service':[mount('skills','/app/data/skills')],
        'catalog-service':[mount('projects','/data/projects'),mount('backups','/app/backups'),mount('runtime-artifacts','/app/runtime-artifacts')],
        'rag-sync-service':[mount('projects','/data/projects')],
        postgres:[mount('postgres','/var/lib/postgresql/data')],
    };
    const states=()=>[...applicationServices,'postgres'].map(service=>({Id:service,Image:image,Config:{Labels:{'com.docker.compose.service':service}},
        State:{Running:service==='postgres'||running,ExitCode:0,OOMKilled:false},Mounts:mounts[service]||[]}));
    const deps={
        composeClient:options=>({...options,run:async(args,config)=>{events.push(args[0]);if(args[0]==='stop'){running=false;assert.ok(config.timeout>0);}if(args[0]==='start'){running=true;}return '';}}),
        composeConfiguration:async()=>({volumes:Object.fromEntries(Object.entries(names).map(([key,name])=>[key,{name}]))}),
        containers:async()=>states(),serviceImageIds:async()=>Object.fromEntries(applicationServices.map(service=>[service,image])),
        maintenanceLock:async(_client,_image,_kind,action)=>{events.push('lock');try{return await action();}finally{events.push('unlock');}},
        docker:async(args,options={})=>{
            if(args.includes('node'))return 'false';
            if(args.includes('pg_dump')){assert.ok(options.timeout>0);await writeFile(options.outputFile,'дамп базы');return '';}
            const sql=options.input;
            if(sql?.includes('server_version_num'))return '160000';
            if(sql?.includes('json_agg(rolname'))return JSON.stringify(['nc_backup','nc_catalog','nc_owner','nc_provisioner','nc_rag']);
            if(sql?.includes('json_agg(json_build_object'))return JSON.stringify(databases);
            if(sql?.includes('neurocenter_project_databases'))return '[]';
            if(sql?.includes('count(*)'))return '0';
            throw new Error('Неожиданная команда теста');
        },
        volumeTransfer:async(_mode,destination)=>{events.push('copy');await copy();for(const key of volumeKeys){await mkdir(path.join(destination,'files',key),{recursive:true});}},
    };
    const options={directory:root,projectName:'fixture',destination:path.join(root,'snapshot'),offline:true,maxPauseMs:60000};
    try{await action({root,events,options,deps,isRunning:()=>running,setCopy:value=>{copy=value;}});}finally{await rm(root,{recursive:true,force:true});}
}
test('Обычная полная копия проверяется и возвращает приложения до снятия блокировки',async()=>fixture(async f=>{
    const receipt=await backupProduction(f.options,f.deps);assert.equal(receipt.ok,true);await verifyBackup(receipt.destination,receipt.sha256);
    assert.equal(f.isRunning(),true);assert.deepEqual(f.events,['lock','stop','copy','start','unlock']);assert.deepEqual((await readdir(f.root)).sort(),['snapshot']);
}));
test('Обновление получает проверенную копию под той же блокировкой и не запускает старые приложения',async()=>fixture(async f=>{
    const result=await withQuiescedProductionBackup(f.options,{beforePause:()=>f.events.push('preflight'),afterBackup:async receipt=>{await verifyBackup(receipt.destination,receipt.sha256);f.events.push('apply');assert.equal(f.isRunning(),false);return {updated:true};}},f.deps);
    assert.deepEqual(result,{updated:true});assert.deepEqual(f.events,['lock','preflight','stop','copy','apply','unlock']);assert.equal(f.isRunning(),false);
}));
test('Сбой обновления оставляет приложения остановленными с пригодной предварительной копией',async()=>fixture(async f=>{
    await assert.rejects(withQuiescedProductionBackup(f.options,{afterBackup:async()=>{throw new Error('миграция');}},f.deps),/миграция/);
    assert.equal(f.isRunning(),false);assert.equal(f.events.includes('start'),false);assert.deepEqual(await readdir(f.root),['snapshot']);
}));
test('Превышение паузы удаляет partial, возвращает приложения и освобождает блокировку',async t=>fixture(async f=>{
    let now=100000;t.mock.method(Date,'now',()=>now);f.options.maxPauseMs=1000;f.setCopy(async()=>{now+=1001;});
    await assert.rejects(backupProduction(f.options,f.deps),error=>error.code==='MAINTENANCE_PAUSE_EXCEEDED');
    assert.equal(f.isRunning(),true);assert.deepEqual(await readdir(f.root),[]);assert.deepEqual(f.events.slice(-2),['start','unlock']);
}));
test('Неопределённое удаление помощника сохраняет partial и возвращает исходные приложения',async()=>fixture(async f=>{
    f.setCopy(async()=>{const error=new Error('помощник не остановлен');error.retainPartial=true;throw error;});
    await assert.rejects(backupProduction(f.options,f.deps),/помощник/);assert.equal(f.isRunning(),true);
    assert.ok((await readdir(f.root))[0].startsWith('snapshot.partial-'));
}));
test('Ошибка до паузы не останавливает приложения',async()=>fixture(async f=>{
    await assert.rejects(withQuiescedProductionBackup(f.options,{beforePause:()=>{throw new Error('дрейф');},afterBackup:()=>{}},f.deps),/дрейф/);
    assert.equal(f.isRunning(),true);assert.deepEqual(f.events,['lock','unlock']);assert.deepEqual(await readdir(f.root),[]);
}));
test('Отмена файлового помощника дожидается подтверждённого удаления контейнера',async()=>{
    const events=[];let release;const gate=new Promise(resolve=>{release=resolve;});let finished=false;
    const command=volumeTransfer('backup','/fixture',Object.fromEntries(volumeKeys.map(key=>[key,key])),image,async()=>{events.push('copy');throw new Error('timeout');},async args=>{
        events.push(args[0]);if(args[0]==='ps')return 'worker';await gate;return '';
    }).finally(()=>{finished=true;});
    const observed=assert.rejects(command,/timeout/);await new Promise(resolve=>setImmediate(resolve));assert.equal(finished,false);assert.deepEqual(events,['copy','ps','rm']);release();await observed;assert.equal(finished,true);
});
test('Неподтверждённая остановка помощника помечает partial для сохранения',async()=>{
    await assert.rejects(volumeTransfer('backup','/fixture',Object.fromEntries(volumeKeys.map(key=>[key,key])),image,async()=>{},async()=>{throw new Error('Docker недоступен');}),error=>error.retainPartial===true);
});

test('Readonly guard обычной копии выполняется под блокировкой и сохраняет штатный resume',async()=>fixture(async f=>{
    await backupProduction({...f.options,beforePause:()=>f.events.push('guard')},f.deps);
    assert.deepEqual(f.events,['lock','guard','stop','copy','start','unlock']);assert.equal(f.isRunning(),true);
}));
test('Отклонённый guard обычной копии не останавливает приложения и не оставляет partial',async()=>fixture(async f=>{
    await assert.rejects(backupProduction({...f.options,beforePause:()=>{const error=new Error('окно закрыто');error.code='CONFIG_CHANGED';throw error;}},f.deps),error=>error.code==='CONFIG_CHANGED');
    assert.deepEqual(f.events,['lock','unlock']);assert.equal(f.isRunning(),true);assert.deepEqual(await readdir(f.root),[]);
}));
