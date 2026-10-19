import {test} from 'node:test';
import assert from 'node:assert/strict';
import {maintenanceTick,externalStorageBinding,createMaintenanceStore,runnerLedger} from '../production/maintenance.mjs';
import {mkdtemp,mkdir,writeFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {volumeKeys} from '../production/recovery-files.mjs';
import {writeManifest} from '../production/recovery-manifest.mjs';
import {applicationServices} from '../production/compose-client.mjs';
import {defaultPolicy} from '../../services/shared/maintenance-policy.cjs';
function fixture(){
    let ledger=null;const calls=[];const receipt={ok:true,createdAt:'2026-10-18T02:00:00Z',independence:'operator-declared',verification:'sha256-readback',backupId:'backup-one',manifestSha256:'a'.repeat(64),storageId:'independent-one',verifiedAt:'2026-10-18T02:05:00Z'};
    const options={resolveStorage:async()=>({endpoint:'https://s3.example.test',bucket:'independent',region:'region-1',storageId:'independent-one'}),load:async()=>({revision:2,policy:{...structuredClone(defaultPolicy),enabled:true}}),claim:async()=>{calls.push('claim');return true;},finish:async()=>calls.push('finish'),fail:async(id,code)=>calls.push(code),readLedger:async()=>ledger,writeLedger:async(slot,value)=>{ledger=value;},backup:async input=>{await input.beforePause();calls.push(['backup',input.maxPauseMs]);return {destination:'/private/backup',sha256:'a'.repeat(64),createdAt:'2026-10-18T02:00:00Z'};},verify:async()=>calls.push('verify'),upload:async input=>{calls.push('upload');return {...receipt,backupId:input.backupId,storageId:input.config.storageId};},prune:async count=>calls.push(['prune',count]),now:()=>new Date('2026-10-18T02:00:00Z')};
    return {options,calls,setLedger:value=>{ledger=value;},getLedger:()=>ledger};
}
test('Полный запуск учитывает максимальную паузу и очищает только после внешней проверки',async()=>{const f=fixture();const result=await maintenanceTick(f.options);assert.equal(result.ok,true);assert.deepEqual(f.calls,['claim',['backup',1800000],'upload','finish',['prune',5]]);assert.ok(f.getLedger().receipt);});
test('Выключенное расписание и время вне окна не берут слот',async()=>{const f=fixture();f.options.now=()=>new Date('2026-10-18T00:00:00Z');assert.equal((await maintenanceTick(f.options)).reason,'OUTSIDE_WINDOW');assert.deepEqual(f.calls,[]);f.options.load=async()=>({policy:defaultPolicy,revision:0});assert.equal((await maintenanceTick(f.options)).reason,'DISABLED');});
test('Занятый или выполненный слот не создаёт повторной копии',async()=>{const f=fixture();f.options.claim=async()=>false;assert.equal((await maintenanceTick(f.options)).skipped,true);assert.deepEqual(f.calls,[]);});
test('Сбой внешней доставки сохраняет комплект и повторяет только передачу',async()=>{const f=fixture();const upload=f.options.upload;f.options.upload=async()=>{throw new Error('transient');};await assert.rejects(()=>maintenanceTick(f.options));assert.ok(f.getLedger());assert.equal(f.calls.at(-1),'EXTERNAL_FAILED');f.calls.length=0;f.options.upload=upload;await maintenanceTick(f.options);assert.deepEqual(f.calls,['claim','verify','upload','finish',['prune',5]]);});
test('Повтор после неизвестного результата записи использует уже проверенную квитанцию',async()=>{const f=fixture();f.options.finish=async()=>{throw new Error('db unavailable');};await assert.rejects(()=>maintenanceTick(f.options));f.calls.length=0;f.options.finish=async()=>f.calls.push('finish');await maintenanceTick(f.options);assert.deepEqual(f.calls,['claim','verify','finish',['prune',5]]);});
test('Повреждённый локальный комплект блокирует внешнюю публикацию и очистку',async()=>{const f=fixture();f.setLedger({source:'/private/backup',sha256:'a'.repeat(64),backupId:'backup-one'});f.options.verify=async()=>{throw new Error('SHA');};await assert.rejects(()=>maintenanceTick(f.options));assert.deepEqual(f.calls,['claim','BACKUP_FAILED']);});
test('Неполная внешняя квитанция не считается успехом',async()=>{const f=fixture();f.options.upload=async()=>({verification:'local'});await assert.rejects(()=>maintenanceTick(f.options));assert.equal(f.calls.at(-1),'EXTERNAL_FAILED');assert.ok(!f.calls.includes('finish'));});
test('Ошибка локальной очистки сохраняет подтверждённый успех',async()=>{const f=fixture();f.options.prune=async()=>{throw new Error('disk');};assert.equal((await maintenanceTick(f.options)).retentionWarning,true);assert.ok(f.calls.includes('finish'));});

test('Смена endpoint, bucket, region или storageId повторяет передачу до подтверждения нового места',async()=>{
    for(const [key,value] of [['endpoint','https://other.example.test'],['bucket','other-bucket'],['region','other-1'],['storageId','independent-two']]){
        const f=fixture();f.options.finish=async()=>{throw new Error('db unavailable');};await assert.rejects(maintenanceTick(f.options));
        const original=await f.options.resolveStorage();f.options.resolveStorage=async()=>({...original,[key]:value});f.options.finish=async()=>f.calls.push('finish');f.calls.length=0;
        await maintenanceTick(f.options);assert.deepEqual(f.calls,['claim','verify','upload','finish',['prune',5]]);
    }
});
test('Смена ключа того же места не подменяет storage binding и не повторяет готовую передачу',async()=>{
    const f=fixture();f.options.finish=async()=>{throw new Error('db unavailable');};await assert.rejects(maintenanceTick(f.options));
    const original=await f.options.resolveStorage();f.options.resolveStorage=async()=>({...original,secretAccessKey:'rotated'});f.options.finish=async()=>f.calls.push('finish');f.calls.length=0;
    await maintenanceTick(f.options);assert.deepEqual(f.calls,['claim','verify','finish',['prune',5]]);
});
test('Старая квитанция без действующего S3-конфига не даёт успех и очистку',async()=>{
    const f=fixture();f.options.finish=async()=>{throw new Error('db unavailable');};await assert.rejects(maintenanceTick(f.options));f.calls.length=0;
    f.options.resolveStorage=async()=>{throw new Error('missing configuration');};f.options.finish=async()=>f.calls.push('finish');
    await assert.rejects(maintenanceTick(f.options),/configuration/);assert.deepEqual(f.calls,['claim','EXTERNAL_FAILED']);
});
test('Некорректная точка данных или чужое хранилище не считаются проверенной внешней копией',async()=>{
    for(const change of [{createdAt:'bad-date'},{createdAt:'2026-10-18T02:01:00Z'},{verifiedAt:'2026-10-18T01:59:00Z'},{storageId:'other'},{ok:false},{independence:'unknown'}]){
        const f=fixture();const upload=f.options.upload;f.options.upload=async value=>({...await upload(value),...change});
        await assert.rejects(maintenanceTick(f.options));assert.ok(!f.calls.includes('finish'));assert.equal(f.calls.at(-1),'EXTERNAL_FAILED');
    }
});
test('Превышенная пауза получает отдельную видимую причину отказа',async()=>{
    const f=fixture();f.options.backup=async()=>{const error=new Error('deadline');error.code='MAINTENANCE_PAUSE_EXCEEDED';throw error;};
    await assert.rejects(maintenanceTick(f.options));assert.equal(f.calls.at(-1),'PAUSE_EXCEEDED');
});
test('SQL-адаптер не считает успехом нулевой переход и не подтверждает чужой ID слота',async()=>{
    const sql=[];let output='0';const store=createMaintenanceStore(async value=>{sql.push(value);return output;});
    await assert.rejects(store.finish('00000000-0000-0000-0000-000000000001',{}),/уже завершён/);assert.equal(await store.fail('00000000-0000-0000-0000-000000000001','EXTERNAL_FAILED'),false);
    output='["00000000-0000-0000-0000-000000000002"]';assert.equal(await store.claim({runId:'00000000-0000-0000-0000-000000000001',slot:'slot',revision:1}),false);
    assert.ok(sql.at(-1).includes('PERFORM pg_advisory_xact_lock'));assert.ok(sql[0].includes('FROM moved'));
    await assert.rejects(store.claim({runId:'id',slot:'slot',revision:'1;DROP TABLE maintenance_runs'}),/ревизия/);
});
test('Retention другого места не удаляет локальные комплекты до повторной внешней проверки',async()=>{
    const directory=await mkdtemp(path.join(tmpdir(),'nc-storage-binding-')),backupRoot=path.join(directory,'backups');
    try{
        const ledger=await runnerLedger(directory,backupRoot),oldBinding=externalStorageBinding({endpoint:'https://old.example.test',bucket:'old',region:'one',storageId:'old'}),newBinding=externalStorageBinding({endpoint:'https://new.example.test',bucket:'new',region:'one',storageId:'new'});
        for(let index=1;index<=4;index++){
            const source=path.join(ledger.backupRoot,'nc-'+String(index).repeat(16));await mkdir(source,{mode:0o700});await mkdir(path.join(source,'databases'));
            for(const name of ['catalog','rag'])await writeFile(path.join(source,'databases',name+'.dump'),'dump');
            for(const key of volumeKeys)await mkdir(path.join(source,'files',key),{recursive:true});
            const createdAt='2026-10-0'+index+'T00:00:00Z',image='sha256:'+'a'.repeat(64),slot='slot-'+index;
            const {sha256}=await writeManifest(source,{createdAt,postgresMajor:16,postgresImage:image,images:Object.fromEntries(applicationServices.map(service=>[service,image])),quiesced:true,databases:['catalog','rag'].map(name=>({name,owner:name==='catalog'?'nc_catalog':'nc_rag',encoding:'UTF8',collate:'C',ctype:'C',file:'databases/'+name+'.dump'}))});
            const backupId='backup-'+index;await ledger.write(slot,{source,slot,sha256,createdAt,backupId,storageBinding:index<=2?oldBinding:newBinding,receipt:{ok:true,verification:'sha256-readback',manifestSha256:sha256,createdAt,verifiedAt:createdAt,storageId:index<=2?'old':'new',backupId,independence:'operator-declared'}});
        }
        await ledger.prune(1,newBinding);assert.deepEqual((await readdir(backupRoot)).sort(),['nc-'+'1'.repeat(16),'nc-'+'2'.repeat(16),'nc-'+'4'.repeat(16)]);
    }finally{await rm(directory,{recursive:true,force:true});}
});

test('Изменение ревизии между claim и остановкой отменяет копию с видимой причиной',async()=>{
    const f=fixture();let loads=0;const load=f.options.load;f.options.load=async()=>({...await load(),revision:++loads===1?2:3});
    await assert.rejects(maintenanceTick(f.options),/изменились/);assert.deepEqual(f.calls,['claim','CONFIG_CHANGED']);assert.equal(f.getLedger(),null);
});
test('Долгая подготовка Docker не позволяет начать паузу после закрытия полного окна',async()=>{
    const f=fixture();let now=new Date('2026-10-18T04:29:00Z');f.options.now=()=>now;const backup=f.options.backup;
    f.options.backup=async value=>{now=new Date('2026-10-18T04:31:00Z');return backup(value);};
    await assert.rejects(maintenanceTick(f.options),/изменились/);assert.deepEqual(f.calls,['claim','CONFIG_CHANGED']);assert.equal(f.getLedger(),null);
});
