import {randomUUID} from 'node:crypto';
import {mkdir,lstat,open} from 'node:fs/promises';
import path from 'node:path';
import {configuration} from '../embedding/config.mjs';
import {dataDirectory} from '../embedding/runtime.mjs';
import {runModelStartupProcess} from './startup-process.mjs';
import {modelBundleFailure} from './bundle-errors.mjs';

/** Подробности команды остаются в закрытом файле; исключения и настройки не печатаются в общий вывод. */
async function saveRuntimeDiagnostic(root,result) {
    try {
        const state=path.join(root,'.run');await mkdir(state,{recursive:true,mode:0o700});
        const stateInfo=await lstat(state);if(!stateInfo.isDirectory()||stateInfo.isSymbolicLink())return;
        const directory=path.join(state,'model-hosting');
        await mkdir(directory,{recursive:true,mode:0o700});
        const info=await lstat(directory);if(!info.isDirectory()||info.isSymbolicLink()||info.mode&0o077)return;
        const filename=path.join(directory,`${randomUUID()}.log`),file=await open(filename,'wx',0o600);
        try {await file.writeFile(`status=${result?.status ?? 'unknown'}\nsignal=${result?.signal ?? ''}\n`
            +[result?.stderr,result?.stdout,result?.error?.message].filter(Boolean).join('\n').slice(-2*1024*1024));}
        finally {await file.close();}
        return filename;
    } catch { /* Ошибка диагностики не мешает запуску остальных сервисов. */ }
}

function assertNotCancelled(result) {
    if(result?.error?.code==='ECANCELED')throw Object.assign(new Error('Запуск хостинга моделей прерван. Прежние сервисы не остановлены.'),
        {code:'ECANCELED',signal:result.signal});
}

/** Сообщение остаётся видимым во время молчащей проверки SHA или ожидания Docker. */
const waiting = (output,label) => elapsed => output.info(label,`Прошло ${Math.floor(elapsed/1000)} с; операция продолжается. Ctrl+C — прервать запуск.`);

/** Native dev использует тот же контейнер и веса, что и команды embedding/vision. */
export function modelRuntimeEnvironment(root,environment=process.env) {
    const config=configuration(environment,root);
    return {MODEL_RUNTIME_URL:environment.MODEL_RUNTIME_URL||config.baseUrl,
        MODEL_STORAGE_PATH:environment.MODEL_STORAGE_PATH||config.data};
}

/** Встроенные веса входят в поставку и готовятся до запуска runtime; пользовательские модели добавляются отдельно. */
export async function startModelRuntime({root,environment=process.env,output},run=runModelStartupProcess) {
    if(environment.MODEL_HOSTING_ENABLED==='false') {
        output.info('Хостинг моделей','Отключён настройкой MODEL_HOSTING_ENABLED');return {ok:true,disabled:true};
    }
    const config=configuration(environment,root);
    await dataDirectory(config,'',true);
    output.info('Проверка и подготовка весов','Проверяем SHA-256 полного комплекта; отсутствующие части загрузятся с продолжением из кеша.');
    const prepared=await run(process.execPath,[path.join(root,'scripts/models/bundle-cli.mjs'),'--directory',config.data],
        {cwd:root,env:environment,encoding:'utf8',stdio:['ignore','pipe','inherit'],maxBuffer:2*1024*1024,timeout:2*60*60*1000,
            onTick:waiting(output,'Подготовка весов')});
    assertNotCancelled(prepared);
    let bundle;
    try {bundle=JSON.parse(prepared.stdout);} catch { /* Неподтверждённая поставка не считается готовой. */ }
    if(prepared.error||prepared.status!==0||bundle?.ok!==true||bundle.downloadOnly!==false||bundle.verifyOnly!==false
        ||bundle.models!==2||bundle.files!==9||!Number.isSafeInteger(bundle.bytes)||bundle.bytes<1) {
        const failure=modelBundleFailure(prepared.error?.code==='ETIMEDOUT'?{code:'MODEL_BUNDLE_TIMEOUT'}:
            prepared.error||bundle?.error||{code:prepared.status===0?'MODEL_BUNDLE_PROTOCOL':'MODEL_BUNDLE_FAILED'});
        output.warning(failure.message);
        if(Number.isInteger(prepared.status))output.info('Код подготовки моделей',String(prepared.status));
        if(prepared.signal)output.info('Сигнал подготовки моделей',prepared.signal);
        const diagnostic=await saveRuntimeDiagnostic(root,prepared);
        if(diagnostic)output.info('Подробности подготовки',diagnostic);
        output.info('Повторить только подготовку','npm run models:prepare');
        throw new Error(`Встроенные модели не подготовлены: ${failure.message} Прежние сервисы не остановлены.`);
    }
    output.success('Обе встроенные модели находятся в проекте; файлы проверены по SHA-256');
    output.info('Запуск контейнера моделей','Ожидаем Docker и готовность runtime. Первая загрузка образа может занять несколько минут; предел ожидания — 10 минут.');
    let result;
    try {
        result=await run('docker',['compose','--project-directory',root,'--project-name',config.project,
            '-f',path.join(root,'compose.embedding.yml'),'up','-d','--wait','--wait-timeout','90','embedding'],
            {cwd:root,env:{...environment,EMBEDDING_PORT:String(config.port)},encoding:'utf8',maxBuffer:2*1024*1024,timeout:10*60*1000,
                onTick:waiting(output,'Docker: запуск хостинга')});
        assertNotCancelled(result);
        if(result.error||result.status!==0)throw new Error('Не удалось подготовить контейнер моделей.');
        output.success('Хостинг моделей готов; встроенные веса уже доступны');
        return {ok:true};
    } catch(error) {
        if(error.code==='ECANCELED')throw error;
        output.warning('Хостинг моделей недоступен — остальные сервисы продолжат запуск');
        output.info('Причина',result?.error?.code==='ETIMEDOUT'?'Docker не завершил запуск за 10 минут.'
            :result?.error?.code==='ENOBUFS'?'Вывод Docker превысил допустимый объём; команда остановлена.'
            :result?.error?.code==='ENOENT'?'Команда Docker не найдена.'
            :`Docker не подтвердил готовность контейнера${Number.isInteger(result?.status)?` (код ${result.status})`:''}.`);
        const diagnostic=await saveRuntimeDiagnostic(root,result || {error});
        if(diagnostic)output.info('Подробности Docker',diagnostic);
        output.info('Повторить запуск','scripts/dev.sh up');
        return {ok:false};
    }
}
