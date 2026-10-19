import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {configuration} from '../embedding/config.mjs';
import {dataDirectory} from '../embedding/runtime.mjs';

/** Native dev использует тот же контейнер и веса, что и команды embedding/vision. */
export function modelRuntimeEnvironment(root,environment=process.env) {
    const config=configuration(environment,root);
    return {MODEL_RUNTIME_URL:environment.MODEL_RUNTIME_URL||config.baseUrl,
        MODEL_STORAGE_PATH:environment.MODEL_STORAGE_PATH||config.data};
}

/** Встроенные веса входят в поставку и готовятся до запуска runtime; пользовательские модели добавляются отдельно. */
export async function startModelRuntime({root,environment=process.env,output},run=spawnSync) {
    if(environment.MODEL_HOSTING_ENABLED==='false') {
        output.info('Хостинг моделей','Отключён настройкой MODEL_HOSTING_ENABLED');return {ok:true,disabled:true};
    }
    const config=configuration(environment,root);
    await dataDirectory(config,'',true);
    output.info('Встроенные модели','Подготавливаем полный комплект весов в data/embedding/models');
    const prepared=run(process.execPath,[path.join(root,'scripts/models/bundle-cli.mjs'),'--directory',config.data],
        {cwd:root,env:environment,encoding:'utf8',stdio:['ignore','pipe','inherit'],maxBuffer:2*1024*1024,timeout:2*60*60*1000});
    let bundle;
    try {bundle=JSON.parse(prepared.stdout);} catch { /* Неподтверждённая поставка не считается готовой. */ }
    if(prepared.error||prepared.status!==0||bundle?.ok!==true||bundle.downloadOnly!==false||bundle.verifyOnly!==false
        ||bundle.models!==2||bundle.files!==9||!Number.isSafeInteger(bundle.bytes)||bundle.bytes<1) {
        throw new Error('Встроенные модели не подготовлены. Проверьте сообщение выше, свободное место и повторите scripts/dev.sh up. Прежние сервисы не остановлены.');
    }
    output.success('Обе встроенные модели находятся в проекте; файлы проверены по SHA-256');
    try {
        const result=run('docker',['compose','--project-directory',root,'--project-name',config.project,
            '-f',path.join(root,'compose.embedding.yml'),'up','-d','--wait','--wait-timeout','90','embedding'],
            {cwd:root,env:{...environment,EMBEDDING_PORT:String(config.port)},encoding:'utf8',maxBuffer:2*1024*1024,timeout:10*60*1000});
        if(result.error||result.status!==0)throw new Error('Не удалось подготовить контейнер моделей.');
        output.success('Хостинг моделей готов; встроенные веса уже доступны');
        return {ok:true};
    } catch {
        output.warning('Хостинг моделей недоступен — остальные сервисы продолжат запуск');
        output.info('Повторить запуск','scripts/dev.sh up');
        return {ok:false};
    }
}
