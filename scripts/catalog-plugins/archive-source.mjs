import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import archiveSource from '../../services/shared/archive-source.cjs';
import {detectReadyPayload} from './release-inspection.mjs';
import {prepareRuntimeSource} from './runtime-source.mjs';

/** Retained raw bytes are checked before extraction and copied into the common source envelope. */
export async function inspectArchiveSource(raw,recipeDirectory){
 const source=archiveSource.validateArchiveSource(raw),filename=path.resolve(recipeDirectory,source.file),relative=path.relative(recipeDirectory,filename);
 if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw new Error('Архив выходит за папку сборки.');
 let parent=recipeDirectory;
 for(const part of relative.split(path.sep).slice(0,-1)){parent=path.join(parent,part);const stat=await fs.lstat(parent);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('Путь архива содержит ссылку.');}
 const file=await fs.open(filename,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
  const before=await file.stat();if(!before.isFile()||before.nlink!==1||before.size!==source.bytes)throw new Error('Сохранённый архив отсутствует или повреждён.');
  const hash=createHash('sha256');let bytes=0;for await(const chunk of file.createReadStream({autoClose:false})){bytes+=chunk.length;if(bytes>source.bytes)throw new Error('Архив превышает закреплённый размер.');hash.update(chunk);}
  const after=await file.stat();if(bytes!==source.bytes||hash.digest('hex')!==source.sha256||before.ino!==after.ino||before.mtimeMs!==after.mtimeMs||after.nlink!==1)throw new Error('SHA-256 исходного архива изменился.');
  return {source,filename};
 }finally{await file.close();}
}
export async function prepareArchiveSource(recipe,context,{extractRelease}){
 const {source,filename}=await inspectArchiveSource(recipe.source,context.recipeDirectory),directory=await fs.mkdtemp(path.join(path.dirname(context.directory),'.upload-source-'));
 try{
  const expected=source.runtimeSource.assets[context.target];if(!expected)throw new Error('Готовый архив не поддерживает выбранную платформу.');
  if(source.format==='file'){await fs.mkdir(path.dirname(path.join(directory,expected.app.entrypoint)),{recursive:true});await fs.copyFile(filename,path.join(directory,expected.app.entrypoint));}
  else await extractRelease(filename,{format:source.format},directory);
  const choices=await detectReadyPayload(directory),choice=choices.find(item=>item.entrypoint===expected.app.entrypoint&&item.adapter===source.runtimeSource.adapter&&item.targets.includes(context.target)&&item.runtimeEntrypoint===expected.runtime?.entrypoint);
  if(!choice)throw new Error('Готовое приложение не совпадает с подтверждённым рецептом запуска.');
  const result=await prepareRuntimeSource({...recipe,source:source.runtimeSource},{...context,recipeDirectory:directory},{extractRelease});
  return {...result,upstream:{...result.upstream,sourceArchive:{sha256:source.sha256,bytes:source.bytes}}};
 }finally{await fs.rm(directory,{recursive:true,force:true});}
}
