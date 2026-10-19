#!/usr/bin/env node
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {composeClient,containers} from './compose-client.mjs';
import capacity from '../../services/shared/capacity.cjs';

/** Снимает новый замер с фиксированных read-only mounts сборщика, без SQL/секретов. */
export async function inspectProductionResources({directory,projectName,files=[]}){
    const client=composeClient({directory,projectName,files});
    const states=await containers(client);const collector=states.find(item=>item.Config.Labels['com.docker.compose.service']==='capacity-collector');
    if(!collector?.State.Running){throw new Error('Сборщик физических ресурсов не запущен.');}
    const expected={postgres:['postgres','/var/lib/postgresql/data'],skills:['skills-service','/app/data/skills'],projects:['catalog-service','/data/projects'],backups:['catalog-service','/app/backups'],'runtime-artifacts':['catalog-service','/app/runtime-artifacts']};
    for(const [resource,[service,target]] of Object.entries(expected)){
        const actual=states.find(item=>item.Config.Labels['com.docker.compose.service']===service)?.Mounts.find(mount=>mount.Destination===target);
        const monitored=collector.Mounts.find(mount=>mount.Destination==='/volumes/'+resource);
        if(!actual||actual.Type!=='volume'||!monitored||monitored.Type!=='volume'||monitored.RW!==false||monitored.Name!==actual.Name){throw new Error('Не подтверждены реальные read-only тома сборщика.');}
    }
    const value=JSON.parse(await client.run(['exec','-T','capacity-collector','node','/shared/capacity-collector.cjs','--once']));
    capacity.validateSnapshot(value);return value;
}
async function main(){
    const args=process.argv.slice(2);const values={directory:path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../deploy/production/local')};
    for(let i=0;i<args.length;i++){
        const field={'--directory':'directory','--project-name':'projectName'}[args[i]];if(!field||!args[i+1]){throw new Error('Параметры: --directory <конфиг> --project-name <стек>');}values[field]=args[++i];
    }
    console.log(JSON.stringify(await inspectProductionResources(values),null,2));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){void main().catch(error=>{console.error(error.message);process.exitCode=1;});}
