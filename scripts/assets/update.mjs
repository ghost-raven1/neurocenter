import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {nodeRuntime} from '../workspace/node-runtime.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));

/** Проверка поставки повторяется даже после pull без новых коммитов; новый CLI читается уже после pull. */
export function updateRepository({directory=root,environment=process.env,run=spawnSync}={}) {
    const execute=(command,args,options={})=>{
        const result=run(command,args,{cwd:directory,env:environment,stdio:'inherit',...options});
        if(result.error)throw result.error;
        if(result.status!==0)throw new Error(`Обновление не завершено: ${command===environment.NODE_BIN?'подготовка поставки':'git'} (код ${result.status??1}).`);
        return result;
    };
    const state=execute('git',['status','--porcelain','--untracked-files=no'],{stdio:['ignore','pipe','pipe'],encoding:'utf8'});
    if(state.stdout.trim())throw new Error('Сначала сохраните локальные изменения отслеживаемых файлов. Автоматическое обновление их не перезаписывает.');
    execute('git',['pull','--ff-only'],{env:{...environment,NEUROCENTER_ASSETS_SKIP_HOOK:'1'}});
    execute(environment.NODE_BIN||process.execPath,[path.join(directory,'scripts/assets/cli.mjs')]);
    return {ok:true};
}

async function main() {
    const args=process.argv.slice(2);
    if(args.length===1&&['--help','-h','—help'].includes(args[0])) {console.log('npm run update — git pull --ff-only и полная проверка поставки без перезапуска сервисов.');return;}
    if(args.length)throw new Error('Использование: npm run update');
    const runtime=nodeRuntime();
    if(runtime.node!==process.execPath) {
        const result=spawnSync(runtime.node,[fileURLToPath(import.meta.url)],{env:runtime.env,stdio:'inherit'});
        if(result.error)throw result.error;
        process.exitCode=result.status??1;return;
    }
    updateRepository({environment:runtime.env});
    console.log('Код и поставка обновлены. Примените штатную процедуру запуска или развёртывания.');
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error.message);process.exitCode=1;});
