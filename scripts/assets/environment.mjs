import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {parseEnv} from 'node:util';

/** Настройки машины перекрывают шаблон, а окружение процесса имеет наивысший приоритет. */
export async function assetEnvironment(root, environment=process.env) {
    const merged={};
    for(const file of ['.env','.env.local']) {
        try {Object.assign(merged,parseEnv(await readFile(path.join(root,file),'utf8')));}
        catch(error) {if(error.code!=='ENOENT')throw error;}
    }
    return {...merged,...environment};
}
