import fs from 'node:fs/promises';
import path from 'node:path';
import codexSource from '../../services/shared/codex-connector-source.cjs';
import {preparedSourceAdapter} from './prepared-source-snapshot.mjs';
import {projectFiles,extractRelease} from './source-adapters.mjs';
import {downloadRepositoryArchive,repositoryRoot} from './repository-source.mjs';
import {sourceInventory,projectInventory} from './source-inventory.mjs';

/** Preflight reads immutable source bytes and never installs dependencies or calls the model. */
export async function inspectBuildSource(config,inspectionRoot){
 const candidates=config.agentCandidates??[config.source.entrypoint];
 if(config.source.type==='files')return sourceInventory(config.source.files,candidates,config.targets);
 if(preparedSourceAdapter(config.source)||codexSource.isPreparedCodexRepository(config.source)||config.source.type!=='repository'||config.source.runtimeSource||config.source.release||config.source.snapshotSha256)
  throw Object.assign(new Error('Для автоматического рецепта выберите GitHub или файлы JS/TS. Для готового npm-пакета или runtime отключите агента и повторите упаковку.'),{code:'SOURCE_RUNTIME_UNSUPPORTED'});
 await fs.mkdir(inspectionRoot,{recursive:true,mode:0o700});
 const temporary=await fs.mkdtemp(path.join(inspectionRoot,'recipe-inspect-'));
 try{
  const archive=await downloadRepositoryArchive(config.source,path.join(temporary,'cache'));
  const root=await repositoryRoot(archive.archivePath,config.source);
  const extracted=path.join(temporary,'source');await fs.mkdir(extracted);
  await extractRelease(archive.archivePath,{format:'tar.gz'},extracted);
  return projectInventory({type:'project',directory:[root,config.source.subdirectory].filter(Boolean).join('/'),entrypoint:config.source.entrypoint},
   extracted,candidates,config.targets,projectFiles);
 }finally{await fs.rm(temporary,{recursive:true,force:true});}
}
