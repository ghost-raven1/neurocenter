import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {test} from 'node:test';

const entry = fileURLToPath(new URL('../../mcp/neurocenter-asset-sync/dist/index.js',import.meta.url));

/** Настоящий CLI получает только подставной upgrade; сеть и пользовательский профиль не используются. */
test('CLI передаёт факт паузы и конкретную причину отказа установщику',async () => {
    const directory = await mkdtemp(path.join(tmpdir(),'nc-upgrade-cli-'));
    try {
        const implementation = path.join(directory,'upgrade.mjs'),hook = path.join(directory,'hook.mjs');
        await writeFile(implementation, `
export async function prepareWorkerUpgrade() {
    if(process.env.UPGRADE_TEST_MODE==='error')throw Error('На компьютере выполняется проверка папки.');
    return {paused:process.env.UPGRADE_TEST_MODE==='paused'};
}
export async function finishWorkerUpgrade() {}
export async function ensureCurrentWorker() {}
export async function waitForWorkerInstallation() {return true;}
`);
        await writeFile(hook, `
import {registerHooks} from 'node:module';
globalThis.fetch=()=>{throw Error('Сеть запрещена в проверке CLI');};
registerHooks({resolve(specifier,context,next){
    if(specifier.endsWith('/worker-upgrade.js'))return {url:${JSON.stringify(pathToFileURL(implementation).href)},shortCircuit:true};
    return next(specifier,context);
}});
`);
        for(const mode of ['paused','unpaused','error']) {
            const result = spawnSync(process.execPath,['--import',hook,entry,'--prepare-upgrade',path.join(directory,'installed/dist/index.js')],{
                env:{...process.env,UPGRADE_TEST_MODE:mode,NEUROCENTER_BRIDGE_HOME:path.join(directory,'state'),XDG_CONFIG_HOME:path.join(directory,'config')},
                encoding:'utf8',timeout:15000,
            });
            assert.equal(result.error,undefined);
            assert.equal(result.status,mode==='error'?1:0,result.stderr);
            assert.deepEqual(JSON.parse(result.stdout),mode==='error'
                ?{ok:false,error:'На компьютере выполняется проверка папки.'}:{ok:true,paused:mode==='paused'});
        }
    } finally {await rm(directory,{recursive:true,force:true});}
});
