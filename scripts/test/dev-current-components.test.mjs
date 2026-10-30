import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';

const root=fileURLToPath(new URL('../../',import.meta.url));

/** Signals are emitted only in this owned child; no Docker, running service or real bridge is reached. */
for(const mode of ['ready','image-error','SIGINT','SIGTERM'])test('Optional snapshot preparation preserves cancellation and listener cleanup: '+mode,async t=>{
    const directory=await fs.mkdtemp(path.join(os.tmpdir(),'neurocenter optional snapshot '));
    t.after(()=>fs.rm(directory,{recursive:true,force:true}));
    await fs.copyFile(path.join(root,'scripts/workspace/dev-current-components.mjs'),path.join(directory,'dev-current-components.mjs'));
    await fs.writeFile(path.join(directory,'catalog-rebuild-request.mjs'),'export async function writeCatalogRebuildRequest(){}');
    await fs.writeFile(path.join(directory,'dev-snapshots.mjs'),`
        export async function buildDevSnapshotImage(){
            await Promise.resolve();
            const mode=process.env.OWN_SNAPSHOT_MODE;
            if(mode.startsWith('SIG'))process.emit(mode);
            if(mode!=='ready')throw Error('owned image failed');
            return 'sha256:'+'a'.repeat(64);
        }
        export const inspectDevSnapshotImage=buildDevSnapshotImage;
    `);
    const probe=path.join(directory,'probe.mjs');
    await fs.writeFile(probe,`
        import {optionalDevSnapshotImage} from './dev-current-components.mjs';
        const before=['SIGINT','SIGTERM'].map(signal=>process.listenerCount(signal)),warnings=[];
        let image,error;
        try{image=await optionalDevSnapshotImage({root:'.',build:true,output:{warning:value=>warnings.push(value)}});}
        catch(failure){error={message:failure.message,code:failure.code,signal:failure.signal};}
        console.log(JSON.stringify({image,error,warnings,before,after:['SIGINT','SIGTERM'].map(signal=>process.listenerCount(signal))}));
    `);
    const result=spawnSync(process.execPath,[probe],{env:{OWN_SNAPSHOT_MODE:mode},encoding:'utf8',timeout:5000});
    assert.equal(result.error,undefined);assert.equal(result.status,0,result.stderr);
    const observed=JSON.parse(result.stdout);assert.deepEqual(observed.after,observed.before);
    if(mode==='ready'){assert.equal(observed.image,'sha256:'+'a'.repeat(64));assert.deepEqual(observed.warnings,[]);assert.equal(observed.error,undefined);}
    else if(mode==='image-error'){assert.equal(observed.image,undefined);assert.equal(observed.error,undefined);assert.equal(observed.warnings.length,1);assert.match(observed.warnings[0],/Проверка снимков недоступна/);}
    else {assert.equal(observed.image,undefined);assert.deepEqual(observed.error,{message:'Подготовка снимков прервана ('+mode+').',code:'ECANCELED',signal:mode});assert.deepEqual(observed.warnings,[]);}
});
