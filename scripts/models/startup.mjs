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

/** Запускает только пустой runtime; многогигабайтные модели загружаются по явному действию в каталоге. */
export async function startModelRuntime({root,environment=process.env,output},run=spawnSync) {
    if(environment.MODEL_HOSTING_ENABLED==='false') {
        output.info('Хостинг моделей','Отключён настройкой MODEL_HOSTING_ENABLED');return {ok:true,disabled:true};
    }
    try {
        const config=configuration(environment,root);
        await dataDirectory(config,'',true);
        const result=run('docker',['compose','--project-directory',root,'--project-name',config.project,
            '-f',path.join(root,'compose.embedding.yml'),'up','-d','--wait','--wait-timeout','90','embedding'],
            {cwd:root,env:{...environment,EMBEDDING_PORT:String(config.port)},encoding:'utf8',maxBuffer:2*1024*1024,timeout:10*60*1000});
        if(result.error||result.status!==0)throw new Error('Не удалось подготовить контейнер моделей.');
        output.success('Хостинг моделей готов; веса загружаются из каталога по запросу');
        return {ok:true};
    } catch {
        output.warning('Хостинг моделей недоступен — остальные сервисы продолжат запуск');
        output.info('Повторить запуск','scripts/dev.sh up');
        return {ok:false};
    }
}
