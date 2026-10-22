import {createRequire} from 'node:module';
import path from 'node:path';

/** Child process is a real PackageBuildService worker; no builder/process imports are mocked. */
const dist=process.env.TOOL_BUILD_WORKER_DIST;
if(!dist||!path.isAbsolute(dist)||!process.send)throw Error('Explicit compiled worker and IPC parent are required');
const require=createRequire(new URL('../../services/catalog-service/package.json',import.meta.url));
const {AccessDb}=require(path.join(dist,'access/access-db.js'));
const {PackageBuildService}=require(path.join(dist,'package-build/package-build.service.js'));
const access=new AccessDb(),service=new PackageBuildService(access,{}, {ensureSchema:async()=>{}},{});
let closing;
const safeMessage=error=>String(error?.message??'Worker failed').replace(/postgres(?:ql)?:\/\/\S+/gi,'[redacted database]').slice(0,500);
const close=()=>closing??=(async()=>{await service.onModuleDestroy();await access.onModuleDestroy();if(process.connected)process.disconnect();})();
process.on('message',message=>{if(message?.type==='stop')void close().catch(error=>{process.send?.({type:'fatal',message:safeMessage(error)});process.exitCode=1;if(process.connected)process.disconnect();});});
process.on('SIGTERM',()=>{void close();});process.on('SIGINT',()=>{void close();});
process.on('disconnect',()=>{void close();});
try{await access.ready();await service.onModuleInit();process.send({type:'ready',pid:process.pid});}
catch(error){process.send?.({type:'fatal',message:safeMessage(error)});await close().catch(()=>{});process.exitCode=1;}
