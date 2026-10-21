#!/usr/bin/env node
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {withDockerBuildCa} from './workspace/docker-build-ca.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const args=process.argv.slice(2);
if(args[0]!=='compose'||!args.includes('build')){
    console.error('Использование: node scripts/docker-build.mjs compose [параметры Compose] build [сервисы]');
    process.exitCode=1;
}else{
    try{
        await withDockerBuildCa(root,process.env,({environment})=>new Promise((resolve,reject)=>{
            const child=spawn('docker',args,{cwd:root,env:environment,stdio:'inherit'});
            child.on('error',reject);child.on('exit',(code,signal)=>{if(code===0){resolve();}else{reject(new Error('Сборка Docker не выполнена'+(signal?' ('+signal+')':': '+code)));}});
        }));
    }catch(error){console.error(error.message);process.exitCode=1;}
}
