import path from 'node:path';
import {runModelStartupProcess} from '../models/startup-process.mjs';

/** Поставка проверяется до сборки и остановки приложений, включая повтор после сорванного pull. */
export async function prepareStartupAssets({root,environment=process.env,output,withoutModels=false},run=runModelStartupProcess) {
    const execute=async(script,args=[])=>{
        const result=await run(process.execPath,[path.join(root,script),...args],{
            cwd:root,env:environment,encoding:'utf8',stdio:['ignore','pipe','inherit'],maxBuffer:2*1024*1024,timeout:2*60*60*1000,
            onTick:elapsed=>output.info('Подготовка поставки',`Прошло ${Math.floor(elapsed/1000)} с; проверка продолжается. Ctrl+C — прервать.`),
        });
        if(result.error?.code==='ECANCELED')throw Object.assign(result.error,{signal:result.signal});
        let report;try {report=JSON.parse(result.stdout);} catch { /* Только явное подтверждение CLI означает готовность. */ }
        return {result,report};
    };
    const {result,report}=await execute('scripts/assets/cli.mjs',withoutModels?['--without-models']:[]);
    if(!result.error&&!result.signal&&Number.isInteger(result.status)&&result.status>0&&report?.ok===false
        &&['UNAVAILABLE','ASSET_RETRIEVAL_UNAVAILABLE'].includes(report.error?.code)){
        output.warning('Получить ассеты сейчас не удалось; запуск продолжится с ранее сохранёнными данными. Новые ассеты пока недоступны.');
        output.info('Повторить получение ассетов',`npm run assets:sync${withoutModels?' -- --without-models':''}`);
        return {ok:false,deferred:true,reason:'assets-unavailable'};
    }
    if(result.error||result.status!==0||report?.ok!==true||report.mode!=='prefetch'||report.verifyOnly!==false
        ||report.withoutModels!==(withoutModels?true:undefined)||!(/^[a-f0-9]{64}$/).test(report.revision||'')) {
        throw new Error(`Поставка проекта не подготовлена. Повторите npm run assets:sync${withoutModels?' -- --without-models':''}. Прежние сервисы не остановлены.`);
    }
    output.success(withoutModels?'Ассеты без моделей предзагружены':'Все выбранные ассеты предзагружены');
    return report;
}
