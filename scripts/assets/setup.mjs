import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {nodeRuntime} from '../workspace/node-runtime.mjs';
import {installAssetHooks,uninstallAssetHooks} from './git-hooks.mjs';
import {assetEnvironment} from './environment.mjs';
import {prepareAssetsWithCancellation} from './cancellation.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
const help='npm run assets:init — подключить Git-хуки и подготовить поставку\n'
    +'npm run assets:hooks — только подключить хуки; --uninstall — вернуть прежние хуки';

async function main() {
    const args=process.argv.slice(2);
    if(args.some(value=>['--help','-h','—help'].includes(value))) {console.log(help);return;}
    if(new Set(args).size!==args.length||args.some(value=>!['--hooks-only','--uninstall'].includes(value)))throw new Error(help);
    const runtime=nodeRuntime();
    if(runtime.node!==process.execPath) {
        const result=spawnSync(runtime.node,[fileURLToPath(import.meta.url),...args],{env:runtime.env,stdio:'inherit'});
        if(result.error)throw result.error;
        process.exitCode=result.status??1;return;
    }
    if(args.includes('--uninstall')) {await uninstallAssetHooks({root});console.log('Прежняя настройка Git-хуков восстановлена.');return;}
    await installAssetHooks({root,node:runtime.node});
    console.log('Git-хуки подключены: pull, rebase и смена ветки подготавливают поставку автоматически.');
    if(args.includes('--hooks-only'))return;
    const {modelBundleProgressReporter}=await import('../models/bundle-cli.mjs');
    await prepareAssetsWithCancellation({root,environment:await assetEnvironment(root),onProgress:modelBundleProgressReporter()});
    console.log('Поставка готова. Последующие обновления: git pull.');
}

main().catch(error=>{console.error(error.message);process.exitCode=error.signal==='SIGINT'?130:error.signal==='SIGTERM'?143:1;});
