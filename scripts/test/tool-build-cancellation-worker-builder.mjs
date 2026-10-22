import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';

/** Trusted fixture builder. Production supervisor still controls READY, SQL admission and START. */
const recipePath=process.argv[process.argv.indexOf('--recipe')+1];
const recipe=JSON.parse(fs.readFileSync(recipePath,'utf8'));
const {controlRoot}=JSON.parse(recipe.description);
if(!path.isAbsolute(controlRoot)||!path.basename(process.cwd()).match(/^[a-f0-9-]{36}$/))throw Error('Invalid owned builder fixture');
const id=path.basename(process.cwd()),heartbeat=path.join(controlRoot,id+'.heartbeat'),ready=path.join(controlRoot,id+'.writer.json');
const code=`const fs=require('node:fs');const [heartbeat,stage,ready]=process.argv.slice(1);let tick=0;fs.writeFileSync(ready,JSON.stringify({pid:process.pid,parentPid:process.ppid})+'\\n',{mode:0o600});setInterval(()=>{fs.appendFileSync(heartbeat,String(++tick)+'\\n');try{fs.appendFileSync(require('node:path').join(stage,'writer-stage-heartbeat'),String(tick)+'\\n');}catch(error){fs.appendFileSync(heartbeat,'stage-error:'+error.code+'\\n');}},20);`;
const writer=spawn(process.execPath,['-e',code,heartbeat,process.cwd(),ready],{stdio:'ignore'});
fs.writeFileSync(path.join(controlRoot,id+'.builder.json'),JSON.stringify({builderPid:process.pid,supervisorPid:process.ppid,writerPid:writer.pid,stage:process.cwd(),id})+'\n',{mode:0o600});
setInterval(()=>{},1000);
