import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {nodeRuntime} from '../workspace/node-runtime.mjs';
import {runPreviousHook,shouldSyncAfterHook} from './git-hooks.mjs';
import {assetEnvironment} from './environment.mjs';
import {prepareAssetsWithCancellation} from './cancellation.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));

async function main() {
    const runtime=nodeRuntime();
    if(runtime.node!==process.execPath) {
        const result=spawnSync(runtime.node,[fileURLToPath(import.meta.url),...process.argv.slice(2)],{env:runtime.env,stdio:'inherit'});
        if(result.error)throw result.error;
        process.exitCode=result.status??1;return;
    }
    const [hook,...args]=process.argv.slice(2);
    const previous=await runPreviousHook({root,hook,args});
    if(previous) {process.exitCode=previous;return;}
    if(process.env.NEUROCENTER_ASSETS_SKIP_HOOK==='1'||!shouldSyncAfterHook(hook,args))return;
    console.error('\nНейроцентр · Подготовка поставки после обновления Git');
    const {modelBundleProgressReporter}=await import('../models/bundle-cli.mjs');
    await prepareAssetsWithCancellation({root,environment:await assetEnvironment(root),onProgress:modelBundleProgressReporter()});
    console.error('Поставка подготовлена. Миграции и перезапуск выполняются штатной командой запуска.');
}

main().catch(error=>{
    console.error(error.message);
    console.error('Код Git обновлён, но поставка не готова. Повторите: npm run assets:sync. Запуск повторит проверку.');
    process.exitCode=error.signal==='SIGINT'?130:error.signal==='SIGTERM'?143:1;
});
