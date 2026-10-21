#!/usr/bin/env node
import {mkdir,lstat,writeFile,open} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

/** Вызывается оператором один раз; существующий secret никогда не ротируется автоматически. */
export async function initializeRestoreRunner(directory){
 const secrets=path.join(directory,'secrets');
 for(const folder of [directory,secrets]){await mkdir(folder,{recursive:true,mode:0o700});const info=await lstat(folder);if(!info.isDirectory()||info.isSymbolicLink()||info.mode&0o077)throw new Error('Конфигурация runner должна быть закрыта правами700.');}
 const filename=path.join(secrets,'restore_runner_token');await writeFile(filename,randomBytes(32).toString('hex')+'\n',{flag:'wx',mode:0o600,flush:true});
 const handle=await open(secrets,'r');try{await handle.sync();}finally{await handle.close();}return {created:true};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2);if(args.length!==2||args[0]!=='--directory'){console.error('Нужен --directory <production config>.');process.exitCode=1;}
 else initializeRestoreRunner(path.resolve(args[1])).then(()=>console.log('Закрытый токен исполнителя создан; значение не выводится.')).catch(()=>{console.error('Токен не создан. Проверьте права каталога; существующий токен не заменяется.');process.exitCode=1;});
}
