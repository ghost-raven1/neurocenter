#!/usr/bin/env node
import {lstat,readFile,realpath} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {createRequire} from 'node:module';
import {composeClient,composeConfiguration,maintenanceLock,repositoryRoot,saveDiagnostic} from './compose-client.mjs';
const {normalizeRuntimeArtifacts,inspectRuntimeArchive}=createRequire(import.meta.url)('../../services/shared/runtime-artifacts.cjs');

export function parseImportArguments(args){
    const fields={'--directory':'directory','--project-name':'projectName','--archive':'archive','--descriptor':'descriptor'};const result={directory:path.join(repositoryRoot,'deploy/production/local'),projectName:'neurocenter-production'};const seen=new Set();
    for(let index=0;index<args.length;index++){const key=fields[args[index]];if(!key||seen.has(key)||!args[index+1]||args[index+1].startsWith('--')){throw new Error('Параметры: --archive <готовый.tar.gz> --descriptor <descriptor.json> [--directory <production-конфиг>] [--project-name <стек>]');}seen.add(key);result[key]=args[++index];}
    if(!result.archive||!result.descriptor){throw new Error('Нужны --archive и --descriptor. Исходники и install-скрипты не принимаются.');}return result;
}

/** Проверка готового архива идёт до Docker; общий lock не даёт backup пропустить новый объект. */
export async function importRuntimeArtifact(options){
    const directory=path.resolve(options.directory);const archive=await realpath(options.archive);const descriptorFile=await realpath(options.descriptor);
    for(const filename of [archive,descriptorFile]){if(/[,:\x00-\x1f]/.test(filename)||!(await lstat(filename)).isFile()){throw new Error('Нужны обычные локальные файлы с переносимыми путями.');}}
    if((await lstat(descriptorFile)).size>4096){throw new Error('Описание артефакта превышает 4 КиБ.');}
    const [descriptor]=normalizeRuntimeArtifacts([JSON.parse(await readFile(descriptorFile,'utf8'))]);await inspectRuntimeArchive(archive,descriptor);
    const client=composeClient({directory,projectName:options.projectName});const config=await composeConfiguration(client);
    try{return await maintenanceLock(client,config.services['catalog-service'].image,'runtime-artifact-import',async()=>{
        const result=await client.run(['run','--rm','--no-deps','-T','--volume',archive+':/import/artifact.tar.gz:ro','--volume',descriptorFile+':/import/descriptor.json:ro','catalog-service','node','dist/runtime-artifacts/import.cli.js','/import/artifact.tar.gz','/import/descriptor.json']);return JSON.parse(result);
    });}catch(error){await saveDiagnostic(error,directory);throw error;}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
    process.umask(0o077);Promise.resolve().then(()=>importRuntimeArtifact(parseImportArguments(process.argv.slice(2)))).then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(error instanceof Error?error.message:'Импорт готового комплекта не выполнен.');process.exitCode=1;});
}
