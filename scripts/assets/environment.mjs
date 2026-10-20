import {readFile} from 'node:fs/promises';
import path from 'node:path';

/** parseEnv появился в Node 22.3; ленивая загрузка, чтобы импорт модуля не ломал старую версию. */
let parseEnvModule;
async function parseEnvText(text) {
    const {parseEnv}=parseEnvModule??=await import('node:util');
    return parseEnv(text);
}

/** Настройки машины перекрывают шаблон, а окружение процесса имеет наивысший приоритет. */
export async function assetEnvironment(root, environment=process.env) {
    const merged={};
    for(const file of ['.env','.env.local']) {
        try {Object.assign(merged,await parseEnvText(await readFile(path.join(root,file),'utf8')));}
        catch(error) {if(error.code!=='ENOENT')throw error;}
    }
    return {...merged,...environment};
}
