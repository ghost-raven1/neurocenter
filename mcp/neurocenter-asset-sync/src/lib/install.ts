import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser';
import {hub,apiHub} from '../bridge/state.js';
import {atomicText,syncDirectory} from '../bridge/atomic-file.js';
import {readBoundedSnapshot} from '../bridge/read-bounded.js';
import {withGlobalConfigLock} from './global-config-lock.js';

const changed=()=>new Error('Конфигурация OpenCode изменилась во время установки. Настройки не заменены. Повторите установку.');
async function selectedConfig(dir:string){
    for(const name of ['opencode.jsonc','opencode.json']){
        const configPath=path.join(dir,name);
        const found=await fs.lstat(configPath).catch(error=>{if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;});
        if(found)return {configPath,destination:await fs.realpath(configPath),existing:true};
    }
    return {configPath:path.join(dir,'opencode.json'),destination:path.join(await fs.realpath(dir),'opencode.json'),existing:false};
}

/** Регистрирует мост в JSON/JSONC-конфиге OpenCode, сохраняя комментарии и другие настройки. */
export async function installBridgeGlobal(): Promise<{
    configPath: string; indexJs: string; node: string; created: boolean; method: 'json' | 'jsonc';backupPath?:string;
}> {
    const indexJs = fileURLToPath(new URL('../index.js', import.meta.url));
    const nodePath = process.execPath;
    const entry = { type: 'local', enabled: true, command: [nodePath, indexJs],environment:{NEUROCENTER_URL:hub(),...(apiHub()===hub()?{}:{NEUROCENTER_API_URL:apiHub()})} };
    const dir = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'opencode');
    await fs.mkdir(dir,{recursive:true});
    const selected=await selectedConfig(dir);
    return withGlobalConfigLock(selected.destination,async()=>{
        const current=await selectedConfig(dir);
        if(current.configPath!==selected.configPath||current.destination!==selected.destination)throw changed();
        const {configPath,destination,existing}=current;
        const snapshot=existing?await readBoundedSnapshot(destination,8*1024*1024):undefined;
        const text=snapshot?snapshot.bytes.toString('utf8'):'{}\n';
        if(snapshot&&!Buffer.from(text).equals(snapshot.bytes))throw new Error('Конфигурация OpenCode имеет некорректную кодировку; файл не изменён.');
        const errors: ParseError[] = [];
        const parsed: unknown = parse(text, errors, { allowTrailingComma: true });
        if (errors.length || parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('Конфигурация OpenCode повреждена. Исправьте JSON/JSONC и повторите установку; файл не изменён.');
        }
        const mcp = (parsed as { mcp?: unknown }).mcp;
        if (mcp !== undefined && (mcp === null || typeof mcp !== 'object' || Array.isArray(mcp))) {
            throw new Error('Поле mcp должно быть объектом. Конфигурация не изменена.');
        }
        const out = applyEdits(text, modify(text, ['mcp', 'neurocenter-asset-sync'], entry, {
            formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' },
        }));
        if(!isDeepStrictEqual((parse(out) as {mcp?:Record<string,unknown>})?.mcp?.['neurocenter-asset-sync'],entry)){
            throw new Error('Конфигурация OpenCode содержит неоднозначные поля mcp. Исправьте повторяющиеся поля; файл не изменён.');
        }
        const result={configPath,indexJs,node:nodePath,created:!existing,method:configPath.endsWith('.jsonc')?'jsonc' as const:'json' as const};
        // Проверка не является атомарным CAS для несотрудничающего OpenCode: финальное окно перед rename остаётся.
        const assertUnchanged=async()=>{
            const latest=await selectedConfig(dir);
            if(latest.configPath!==configPath||latest.destination!==destination||latest.existing!==existing)throw changed();
            if(snapshot){
                const after=await readBoundedSnapshot(destination,8*1024*1024);
                if(after.fingerprint!==snapshot.fingerprint||!after.bytes.equals(snapshot.bytes))throw changed();
            }
        };
        if(out===text){await assertUnchanged();return result;}
        const temporary=path.join(path.dirname(destination),'.'+randomUUID()+'.tmp');
        let backupPath:string|undefined;
        try {
            const stat=existing?await fs.stat(destination):undefined;
            if(stat&&stat.nlink!==1)throw new Error('Конфигурация OpenCode имеет несколько жёстких ссылок. Автоматическая замена остановлена; файл не изменён.');
            const handle=await fs.open(temporary,'wx',stat?stat.mode&0o777:0o600);
            try{await handle.writeFile(out);if(stat)await handle.chmod(stat.mode&0o777);await handle.sync();}finally{await handle.close();}
            await assertUnchanged();
            if(snapshot){
                backupPath=path.join(path.dirname(destination),'.neurocenter-opencode-'+randomUUID()+'.bak');
                await atomicText(backupPath,text,0o600);
                await assertUnchanged();
                await fs.rename(temporary,destination);
            }else{
                // Link публикует только отсутствующее имя: появившийся config не перезаписывается.
                try{await fs.link(temporary,destination);}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')throw changed();throw error;}
            }
            await syncDirectory(path.dirname(destination));
        } finally { await fs.rm(temporary, { force: true }); }
        return {...result,...(backupPath?{backupPath}:{})};
    });
}
