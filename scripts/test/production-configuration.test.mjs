import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,stat,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {configureProduction,validateInput,composeEnvironment,ensureMetricsToken} from '../production/configuration.mjs';

const fixture=()=>({panelUrl:'https://panel.example.test',ssoHost:'https://blitz.example.test',ssoClientId:'test-client',ssoClientSecret:'fixture-only',adminEmail:'Admin@example.test',release:'test-20261017',tlsCertFile:'/test/tls.crt',tlsKeyFile:'/test/tls.key'});
test('Сборщик получает отдельный секрет метрик, повторная настройка его сохраняет',async()=>{
    const directory=await mkdtemp(path.join(tmpdir(),'nc-metrics-config-'));
    try{
        await configureProduction(fixture(),directory);
        const metrics=await readFile(path.join(directory,'secrets/metrics_token'),'utf8');
        assert.match(metrics.trim(),/^[a-f0-9]{64}$/);assert.notEqual(metrics,await readFile(path.join(directory,'secrets/internal_token'),'utf8'));
        await configureProduction(fixture(),directory);
        assert.equal(await readFile(path.join(directory,'secrets/metrics_token'),'utf8'),metrics);
        assert.equal((await stat(path.join(directory,'secrets/metrics_token'))).mode&0o777,0o600);
    }finally{await rm(directory,{recursive:true,force:true});}
});
test('Прежний конфиг дополняется ключом метрик без смены паролей или обхода симлинка',async()=>{
    const directory=await mkdtemp(path.join(tmpdir(),'nc-metrics-upgrade-'));
    try{
        await configureProduction(fixture(),directory);
        const internal=await readFile(path.join(directory,'secrets/internal_token'),'utf8');
        const filename=path.join(directory,'secrets/metrics_token');await rm(filename);
        await ensureMetricsToken(directory);
        assert.match((await readFile(filename,'utf8')).trim(),/^[a-f0-9]{64}$/);
        assert.equal(await readFile(path.join(directory,'secrets/internal_token'),'utf8'),internal);
        await rm(filename);await symlink('internal_token',filename);
        await assert.rejects(ensureMetricsToken(directory));
        assert.equal(await readFile(path.join(directory,'secrets/internal_token'),'utf8'),internal);
    }finally{await rm(directory,{recursive:true,force:true});}
});
test('Переменные dev-сессии не перекрывают выбранный production-файл',()=>{
    const source={PANEL_URL:'http://dev.test',NEUROCENTER_CONFIG_DIR:'/real-secrets',COMPOSE_PROFILES:'setup',RAG_DEFAULT_QUOTA_BYTES:'1',RAG_MAX_QUOTA_BYTES:'1',BACKUP_MAX_TOTAL_BYTES:'1',BACKUP_MAX_FILE_BYTES:'1',BACKUP_MIN_FREE_BYTES:'1',PATH:'/usr/bin',DOCKER_HOST:'unix:///test'};
    assert.deepEqual(composeEnvironment(source),{PATH:'/usr/bin',DOCKER_HOST:'unix:///test'});assert.equal(source.NEUROCENTER_CONFIG_DIR,'/real-secrets');
});
test('Бюджет копий положителен, файл не больше общего лимита и настройки попадают в env',async()=>{
    for(const value of [0,-1,1.5,null,'1024',Number.MAX_SAFE_INTEGER+1]){
        for(const key of ['backupMaxTotalBytes','backupMaxFileBytes','backupMinFreeBytes']){assert.throws(()=>validateInput({...fixture(),[key]:value}));}
    }
    assert.throws(()=>validateInput({...fixture(),backupMaxTotalBytes:10,backupMaxFileBytes:11}));
    const directory=await mkdtemp(path.join(tmpdir(),'nc-backup-policy-'));
    try{
        await configureProduction({...fixture(),backupMaxTotalBytes:1000,backupMaxFileBytes:100,backupMinFreeBytes:1},directory);const env=await readFile(path.join(directory,'.env'),'utf8');
        for(const value of ["BACKUP_MAX_TOTAL_BYTES='1000'","BACKUP_MAX_FILE_BYTES='100'","BACKUP_MIN_FREE_BYTES='1'"]){assert.ok(env.includes(value));}
    }finally{await rm(directory,{recursive:true,force:true});}
});
test('Квота production имеет положительные безопасные границы без отключения через ноль',()=>{
    assert.equal(validateInput(fixture()).ragDefaultQuotaBytes,1024**3);
    assert.equal(validateInput(fixture()).ragMaxQuotaBytes,16*1024**3);
    for(const value of [0,-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,'1024',null]){
        assert.throws(()=>validateInput({...fixture(),ragDefaultQuotaBytes:value}));
        assert.throws(()=>validateInput({...fixture(),ragMaxQuotaBytes:value}));
    }
    assert.throws(()=>validateInput({...fixture(),ragDefaultQuotaBytes:2048,ragMaxQuotaBytes:1024}));
});
test('Заданные оператором квоты попадают в выбранный закрытый env-файл',async()=>{
    const directory=await mkdtemp(path.join(tmpdir(),'nc-production-quota-'));
    try{
        await configureProduction({...fixture(),ragDefaultQuotaBytes:1048576,ragMaxQuotaBytes:2097152},directory);
        const env=await readFile(path.join(directory,'.env'),'utf8');
        assert.ok(env.includes("RAG_DEFAULT_QUOTA_BYTES='1048576'"));assert.ok(env.includes("RAG_MAX_QUOTA_BYTES='2097152'"));
    }finally{await rm(directory,{recursive:true,force:true});}
});
test('Пустые реальные параметры не превращаются в рабочий production-конфиг',()=>{
    for(const key of ['panelUrl','ssoHost','ssoClientId','adminEmail','release','tlsCertFile','tlsKeyFile']){assert.throws(()=>validateInput({...fixture(),[key]:''}),undefined,key);}
});
test('HTTP, подмена nginx-конфига и плавающий latest запрещены',()=>{
    for(const input of [{panelUrl:'http://panel.test'},{panelUrl:'https://panel.test:444'},{panelUrl:'https://panel.test/extra'},{panelUrl:'https://panel.test;bad'},{ssoHost:'https://user:secret@blitz.test'},{release:'latest'}]){assert.throws(()=>validateInput({...fixture(),...input}));}
});
test('Повторная настройка сохраняет пароли БД, seed и закрытые права файлов',async()=>{
    const directory=await mkdtemp(path.join(tmpdir(),'nc-production-config-'));
    try{
        await configureProduction(fixture(),directory);const filename=path.join(directory,'secrets/catalog_url');const before=await readFile(filename,'utf8');
        await configureProduction({...fixture(),ssoClientSecret:undefined},directory);assert.equal(await readFile(filename,'utf8'),before);
        for(const filename of ['.env','secrets/catalog_url','secrets/internal_token','secrets/sso_client_secret']){assert.equal((await stat(path.join(directory,filename))).mode&0o777,0o600);}
        assert.equal((await stat(directory)).mode&0o777,0o700);const env=await readFile(path.join(directory,'.env'),'utf8');
        assert.ok(env.includes("BOOTSTRAP_ADMIN_EMAIL='admin@example.test'"));assert.ok(!env.includes('fixture-only'));assert.ok(!env.includes(new URL(before.trim()).password));
    }finally{await rm(directory,{recursive:true,force:true});}
});
test('Ссылка вместо файла секрета не позволяет перезаписать посторонний файл',async()=>{
    const directory=await mkdtemp(path.join(tmpdir(),'nc-production-link-'));
    try{
        await configureProduction(fixture(),directory);const target=path.join(directory,'outside');await writeFile(target,'untouched');
        const secret=path.join(directory,'secrets/sso_client_secret');await rm(secret);await symlink(target,secret);
        await assert.rejects(configureProduction(fixture(),directory));assert.equal(await readFile(target,'utf8'),'untouched');
    }finally{await rm(directory,{recursive:true,force:true});}
});
