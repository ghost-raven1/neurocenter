import {spawn} from 'node:child_process';
import {createReadStream,createWriteStream} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import {fileURLToPath} from 'node:url';
import {mkdir,writeFile,lstat} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {composeEnvironment} from './configuration.mjs';

export const repositoryRoot=fileURLToPath(new URL('../../',import.meta.url));
export const applicationServices=['frontend','api-gateway','oauth2-bridge','rag-sync-service','skills-service','catalog-service'];

/** Потоки дампов не попадают в память или логи оператора. */
export async function docker(args,{input, inputFile, outputFile, inherit=false, timeout=30*60*1000,release}={}){
    const environment=composeEnvironment();
    if(release!==undefined){if(!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(release)||release==='latest'){throw new Error('Некорректная постоянная метка релиза');}environment.NEUROCENTER_RELEASE=release;}
    const child=spawn('docker',args,{cwd:repositoryRoot,env:environment,stdio:inherit?'inherit':['pipe','pipe','pipe']});
    let output='';let stderr='';let tooLarge=false;
    const completion=new Promise((resolve,reject)=>{
        child.on('error',()=>reject(new Error('Не удалось запустить Docker')));
        child.on('close',code=>{
            if(code===0&&!tooLarge){resolve();return;}
            const error=new Error(`Docker: команда ${args[0]} не выполнена (код ${code})`);
            Object.defineProperty(error,'diagnostic',{value:stderr});reject(error);
        });
    });
    // Сообщения PostgreSQL могут содержать пользовательские данные: не печатаем stderr/SQL.
    if(!inherit){child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-16384);});if(!outputFile){child.stdout.on('data',chunk=>{output+=chunk;if(output.length>16*1024*1024){tooLarge=true;child.kill();}});}}
    const timer=setTimeout(()=>child.kill('SIGKILL'),timeout);timer.unref();
    const streams=[];
    if(outputFile){streams.push(pipeline(child.stdout,createWriteStream(outputFile,{flags:'wx',mode:0o600,flush:true})));}
    if(inputFile){streams.push(pipeline(createReadStream(inputFile),child.stdin));}
    else if(!inherit){child.stdin.end(input);}
    try{await Promise.all([completion,...streams]);return output.trim();}
    catch(error){child.kill();await Promise.allSettled([completion,...streams]);throw error;}
    finally{clearTimeout(timer);}
}

/** Подробный stderr доступен только в закрытом каталоге, а не в stdout с пользовательскими данными. */
export async function saveDiagnostic(error,directory){
    if(!error?.diagnostic){return;}
    const info=await lstat(directory);if(!info.isDirectory()||info.isSymbolicLink()||info.mode&0o077){return;}
    const target=path.join(directory,'operation-logs');
    try{await mkdir(target,{mode:0o700});}catch(error){if(error.code!=='EEXIST'){throw error;}}
    const targetInfo=await lstat(target);if(!targetInfo.isDirectory()||targetInfo.isSymbolicLink()||targetInfo.mode&0o077){return;}
    const filename=path.join(target,randomUUID()+'.log');await writeFile(filename,error.diagnostic,{flag:'wx',mode:0o600});return filename;
}

/** Все команды получают один явный Compose-проект и отдельный env-файл. */
export function composeClient({directory,projectName='neurocenter-production',files=[],release}){
    if(!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(projectName)){throw new Error('Некорректное имя Compose-проекта');}
    const args=['compose','--project-directory',repositoryRoot,'--project-name',projectName,'--env-file',path.join(directory,'.env'),'-f',path.join(repositoryRoot,'compose.production.yml'),...files.flatMap(file=>['-f',path.resolve(file)])];
    return {projectName,directory,run:(command,options)=>docker([...args,...command],{...options,...(release===undefined?{}:{release})})};
}

/** Имя контейнера — блокировка на Docker daemon, общая для разных рабочих каталогов. */
export async function maintenanceLock(client,image,operation,action){
    const name='neurocenter-maintenance-'+client.projectName;
    let id;
    try{id=await docker(['create','--name',name,'--label','neurocenter.maintenance='+operation,'--network','none',image,'node','-e','0']);}
    catch{throw new Error('Не удалось взять блокировку '+name+'. Проверьте Docker и незавершённые операции; чужую блокировку не удаляем.');}
    try{return await action();}finally{await docker(['rm',id]);}
}

export async function composeConfiguration(client){return JSON.parse(await client.run(['config','--format','json']));}

export async function containers(client,run=docker){
    const ids=(await client.run(['ps','--all','--quiet'])).split(/\s+/).filter(Boolean);
    return ids.length?JSON.parse(await run(['inspect',...ids])):[];
}

export async function serviceImageIds(config){
    const images={};
    for(const service of applicationServices){
        const name=config.services[service]?.image;if(!name){throw new Error('В production-профиле отсутствует '+service);}
        const [image]=JSON.parse(await docker(['image','inspect',name]));images[service]=image.Id;
    }
    return images;
}
