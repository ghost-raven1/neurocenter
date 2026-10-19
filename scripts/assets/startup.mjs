import path from 'node:path';
import {runModelStartupProcess} from '../models/startup-process.mjs';

/** Поставка проверяется до сборки и остановки приложений, включая повтор после сорванного pull. */
export async function prepareStartupAssets({root,environment=process.env,output},run=runModelStartupProcess) {
    const result=await run(process.execPath,[path.join(root,'scripts/assets/cli.mjs')],{
        cwd:root,env:environment,encoding:'utf8',stdio:['ignore','pipe','inherit'],maxBuffer:2*1024*1024,timeout:2*60*60*1000,
        onTick:elapsed=>output.info('Подготовка поставки',`Прошло ${Math.floor(elapsed/1000)} с; проверка продолжается. Ctrl+C — прервать.`),
    });
    if(result.error?.code==='ECANCELED')throw result.error;
    let report;try {report=JSON.parse(result.stdout);} catch { /* Только явное подтверждение CLI означает готовность. */ }
    if(result.error||result.status!==0||report?.ok!==true||report.mode!=='prefetch'||report.verifyOnly!==false
        ||!(/^[a-f0-9]{64}$/).test(report.revision||'')) {
        throw new Error('Поставка проекта не подготовлена. Повторите npm run assets:sync. Прежние сервисы не остановлены.');
    }
    output.success('Мост, инструменты и модели поставки проверены');
    return report;
}
