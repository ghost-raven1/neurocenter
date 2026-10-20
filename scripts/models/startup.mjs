import {randomUUID} from 'node:crypto';
import {mkdir,lstat,open} from 'node:fs/promises';
import path from 'node:path';
import {configuration} from './runtime-config.mjs';
import {dataDirectory} from './runtime-directory.mjs';
import {runModelStartupProcess} from './startup-process.mjs';

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

/** Native dev запускает общий контейнер; выбранные версии моделей подготавливает каталог. */
export function modelRuntimeEnvironment(root,environment=process.env) {
    const config=configuration(environment,root);
    return {MODEL_RUNTIME_URL:environment.MODEL_RUNTIME_URL||config.baseUrl,
        MODEL_STORAGE_PATH:config.data};
}

/** Запускает runtime; модели добавляются только явным импортом и установкой через каталог. */
export async function startModelRuntime({root,environment=process.env,output},run=runModelStartupProcess) {
    if(environment.MODEL_HOSTING_ENABLED==='false') {
        output.info('Хостинг моделей','Отключён настройкой MODEL_HOSTING_ENABLED');return {ok:true,disabled:true};
    }
    const config=configuration(environment,root);
    await dataDirectory(config,'',true);
    output.info('Запуск контейнера моделей','Ожидаем Docker и готовность runtime. Первая загрузка образа может занять несколько минут; предел ожидания — 10 минут.');
    let result;
    try {
        result=await run('docker',['compose','--project-directory',root,'--project-name',config.project,
            '-f',path.join(root,'compose.embedding.yml'),'up','-d','--wait','--wait-timeout','90','embedding'],
            {cwd:root,env:{...environment,EMBEDDING_PORT:String(config.port),MODEL_STORAGE_PATH:config.data},encoding:'utf8',maxBuffer:2*1024*1024,timeout:10*60*1000,
                onTick:waiting(output,'Docker: запуск хостинга')});
        assertNotCancelled(result);
        if(result.error||result.status!==0)throw new Error('Не удалось подготовить контейнер моделей.');
        output.success('Хостинг моделей готов; выберите модели в каталоге');
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
