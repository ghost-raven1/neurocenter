import {inspectArchiveSource} from './archive-source.mjs';
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {createToolAsset,assetDigest,serializeAsset} from '@neurocenter/asset-contract';
import {preparedSourceFiles} from './prepared-source-snapshot.mjs';
import {toolSourcePath} from './supply-layout.mjs';

/** Для локальных исходников хэшируется переносимый снимок, без путей checkout и ID задания. */
async function snapshotFiles(directory,prefix='',result=[]) {
    for(const entry of (await fs.readdir(path.join(directory,prefix),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
        if(['node_modules','.git'].includes(entry.name))continue;
        const relative=prefix?prefix+'/'+entry.name:entry.name,filename=path.join(directory,relative),before=await fs.lstat(filename);
        if(before.isSymbolicLink()||!before.isFile()&&!before.isDirectory())throw new Error('Source snapshot содержит ссылку или специальный файл.');
        if(before.isDirectory()){await snapshotFiles(directory,relative,result);continue;}
        if(before.size>1048576||result.length>=100||/(^|\/)\.env(?:\.|$)/i.test(relative))throw new Error('Source snapshot: до 100 публичных файлов по 1 МиБ, без .env.');
        const bytes=await fs.readFile(filename),after=await fs.lstat(filename);
        if(bytes.includes(0)||!Buffer.from(bytes.toString('utf8')).equals(bytes)||before.ino!==after.ino||before.mtimeMs!==after.mtimeMs)throw new Error('Source snapshot изменился или содержит не UTF-8 файл.');
        result.push({path:relative,content:bytes.toString('utf8')});
        if(result.reduce((sum,file)=>sum+Buffer.byteLength(file.content),0)>5*1048576)throw new Error('Source snapshot превышает 5 МиБ.');
    }
    return result;
}

/** Native output упаковывается в единственный shared source envelope. */
export async function exportBuiltAsset({recipe,recipeDirectory,destination,publication,descriptors,sources,locks,preparedInputs}) {
    let source;
    if(recipe.source.type==='archive'){
        const {filename}=await inspectArchiveSource(recipe.source,recipeDirectory);
        source={type:'archive',sha256:recipe.source.sha256,bytes:recipe.source.bytes};
        const snapshot=path.join(destination,toolSourcePath(source.sha256));await fs.mkdir(path.dirname(snapshot),{recursive:true});await fs.copyFile(filename,snapshot,constants.COPYFILE_EXCL);
    }
    else if(recipe.source.type==='npm')source={type:'npm',name:recipe.source.package,version:recipe.source.version};
    else if(recipe.source.type==='repository'&&recipe.source.release)source={type:'release',repository:recipe.source.url,tag:recipe.source.release.tag};
    else if(recipe.source.type==='repository')source={type:'git',repository:recipe.source.url,commit:recipe.source.commit,...(recipe.source.subdirectory?{path:recipe.source.subdirectory}:{})};
    else {
        const files=recipe.source.type==='prepared'?preparedInputs??await preparedSourceFiles()
            :['files','project'].includes(recipe.source.type)?await snapshotFiles(path.resolve(recipeDirectory,recipe.source.directory)):undefined;
        const bytes=JSON.stringify({declaration:recipe.source,...(files?{files}:{}),sources,locks},null,2)+'\n';
        source={type:'archive',sha256:assetDigest(bytes),bytes:Buffer.byteLength(bytes)};
        const snapshot=path.join(destination,toolSourcePath(source.sha256));await fs.mkdir(path.dirname(snapshot),{recursive:true});await fs.writeFile(snapshot,bytes,{flag:'wx',mode:0o600});
    }
    const material=JSON.stringify({source,publication,descriptors}),version='build-'+assetDigest(material);
    const asset=createToolAsset({id:recipe.key,version,source,license:{spdx:'NOASSERTION'},publication,artifacts:descriptors.map(descriptor=>({descriptor}))});
    const filename=path.join(destination,'asset.json');
    await fs.writeFile(filename,serializeAsset(asset),{flag:'wx',mode:0o600});
    return filename;
}
