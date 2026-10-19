import path from 'node:path';
import {lstat} from 'node:fs/promises';
import {runModelStartupProcess} from '../models/startup-process.mjs';
import {configuration} from '../embedding/config.mjs';

/** Поставка проверяется до сборки и остановки приложений, включая повтор после сорванного pull. */
export async function prepareStartupAssets({root,environment=process.env,output},run=runModelStartupProcess) {
    const execute=async(script,args=[])=>{
        const result=await run(process.execPath,[path.join(root,script),...args],{
            cwd:root,env:environment,encoding:'utf8',stdio:['ignore','pipe','inherit'],maxBuffer:2*1024*1024,timeout:2*60*60*1000,
            onTick:elapsed=>output.info('Подготовка поставки',`Прошло ${Math.floor(elapsed/1000)} с; проверка продолжается. Ctrl+C — прервать.`),
        });
        if(result.error?.code==='ECANCELED')throw Object.assign(result.error,{signal:result.signal});
        let report;try {report=JSON.parse(result.stdout);} catch { /* Только явное подтверждение CLI означает готовность. */ }
        return {result,report};
    };
    const directory=configuration(environment,root).data;
    let pending=false;
    try {await lstat(path.join(directory,'.bundle-managed/pending.json'));pending=true;}
    catch(error) {if(error.code!=='ENOENT')throw error;}
    if(pending) {
        const {result,report}=await execute('scripts/models/bundle-cli.mjs',['--directory',directory,'--recover-only']);
        if(result.error||result.status!==0||report?.ok!==true||typeof report.recovered!=='boolean') {
            throw new Error('Не удалось восстановить согласованный комплект моделей. Проверьте причину выше и повторите npm run models:prepare -- --recover-only с тем же --directory. Прежние сервисы не остановлены.');
        }
        if(report.recovered)output.success('Восстановлен согласованный комплект после прерванного переключения моделей');
    }
    const {result,report}=await execute('scripts/assets/cli.mjs');
    if(result.error||result.status!==0||report?.ok!==true||report.mode!=='prefetch'||report.verifyOnly!==false
        ||!(/^[a-f0-9]{64}$/).test(report.revision||'')) {
        throw new Error('Поставка проекта не подготовлена. Повторите npm run assets:sync. Прежние сервисы не остановлены.');
    }
    output.success('Мост, инструменты и модели поставки проверены');
    return report;
}
