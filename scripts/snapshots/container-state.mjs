import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {containerObservation,validComposeProject} from '../../services/shared/container-observation.cjs';
const execute=promisify(execFile);
/** Fixed read-only host capability; neither the model nor a request can choose argv or project labels. */
export function createContainerObserver(project,{run=execute,now=()=>Date.now()}={}){
 if(!validComposeProject(project))return async()=>undefined;
 let cached,expires=0;
 return async signal=>{
  signal?.throwIfAborted();if(cached&&now()<expires)return cached;
  const checkedAt=new Date(now()).toISOString(),base={schema:1,project,checkedAt};
  try{
   const {stdout}=await run('docker',['ps','--all','--filter','label=com.docker.compose.project='+project,'--format','{{json .}}'],{encoding:'utf8',timeout:3000,maxBuffer:65536,signal,windowsHide:true});
   const lines=String(stdout).split('\n').filter(Boolean);if(lines.length>64)throw Error('LIMIT');
   const items=lines.map(line=>{const row=JSON.parse(line),labels=String(row.Labels??'').split(',');
    if(!labels.includes('com.docker.compose.project='+project))throw Error('SCOPE');
    const service=labels.find(label=>label.startsWith('com.docker.compose.service='))?.slice('com.docker.compose.service='.length);
    const status=String(row.Status),health=/\(unhealthy\)/.test(status)?'unhealthy':/\(healthy\)/.test(status)?'healthy':/\(health: starting\)/.test(status)?'starting':'not-reported';
    return {service,state:String(row.State),health};});
   cached=containerObservation({...base,available:true,items});
  }catch(error){signal?.throwIfAborted();cached=containerObservation({...base,available:false,reason:error.message==='LIMIT'?'observation-limit':'docker-unavailable'});}
  expires=now()+15000;return cached;
 };
}
