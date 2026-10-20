import {constants} from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {serializeAsset,validateAsset} from '@neurocenter/asset-contract';
import {inspectBuildOutput} from './build.mjs';
import {readyManifest} from './manifest.mjs';
import {toolRuntimePath,toolSourcePath} from './supply-layout.mjs';

/** Создаёт подготовленный public export новой source версии; выпуск ещё нужно опубликовать и прочитать обратно. */
export async function exportCatalogRelease({asset:filename,release,output,dryRun=false}){
    if(typeof filename!=='string'||!filename||typeof output!=='string'||!output||typeof release!=='string'||!/^[a-z0-9][a-z0-9._+-]{0,63}$/i.test(release)||/^(latest|main|master|head)$/i.test(release)||typeof dryRun!=='boolean')throw new Error('Укажите asset.json, неизменяемый release и новую output.');
    const [built]=await readyManifest(filename),asset=structuredClone(built.asset),directory=await inspectBuildOutput(output);
    asset.version='release-'+release;
    asset.delivery.artifacts.forEach(artifact=>{artifact.url=`https://github.com/ghost-raven1/neurocenter-assets/releases/download/${release}/${artifact.descriptor.sha256}.tar.gz`;});
    validateAsset(asset);
    const descriptor=path.join(directory,'asset.json');
    if(!dryRun){
        await fs.mkdir(directory,{recursive:true});if((await fs.readdir(directory)).length)throw new Error('Output должен оставаться пустым.');
        const copied=new Set();for(const artifact of built.artifacts){const name=toolRuntimePath(artifact.descriptor.sha256);if(copied.has(name))continue;const target=path.join(directory,name);await fs.mkdir(path.dirname(target),{recursive:true});await fs.copyFile(artifact.archivePath,target,constants.COPYFILE_EXCL);copied.add(name);}
        for(const retained of built.retainedFiles){const name=built.asset.source.type==='archive'&&retained.archivePath===built.sourceSnapshotPath?toolSourcePath(retained.sha256):built.asset.recipe.path;if(copied.has(name))continue;const target=path.join(directory,name);await fs.mkdir(path.dirname(target),{recursive:true});await fs.copyFile(retained.archivePath,target,constants.COPYFILE_EXCL);copied.add(name);}
        await fs.writeFile(descriptor,serializeAsset(asset),{flag:'wx',mode:0o600});
        // Повторная native-проверка подтверждает, что перенос сохранил точные package pins.
        await readyManifest(descriptor);
    }
    return {ok:true,published:false,dryRun,asset:descriptor,source:asset,release,archives:new Set(built.artifacts.map(item=>item.descriptor.sha256)).size};
}
export function parseReleaseArguments(args){
    const options={dryRun:false},seen=new Set(),fields={'--asset':'asset','--release':'release','--output':'output'};
    for(let index=0;index<args.length;index++){const key=args[index];if(seen.has(key))throw new Error('Параметр повторён.');seen.add(key);if(key==='--dry-run')options.dryRun=true;else if(Object.hasOwn(fields,key)&&args[index+1]&&!args[index+1].startsWith('-'))options[fields[key]]=args[++index];else throw new Error('Параметры: --asset <asset.json> --release <tag> --output <новая папка> [--dry-run].');}
    if(!options.asset||!options.release||!options.output)throw new Error('Укажите --asset, --release и --output.');return options;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))exportCatalogRelease(parseReleaseArguments(process.argv.slice(2))).then(result=>console.log(JSON.stringify(result,null,2))).catch(error=>{console.error(error.message);process.exitCode=1;});
