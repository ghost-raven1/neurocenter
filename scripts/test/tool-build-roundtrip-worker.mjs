import {createRequire} from 'node:module';
import path from 'node:path';

/** Real Catalog worker; only schema bootstrap is supplied by the owning fixture. */
const dist=process.env.TOOL_BUILD_TEST_DIST;
if(!dist||!path.isAbsolute(dist)||!process.send)throw Error('Explicit compiled Catalog and IPC owner are required');
const require=createRequire(new URL('../../services/catalog-service/package.json',import.meta.url));
const {AccessDb}=require(path.join(dist,'access/access-db.js'));
const {DeviceStore}=require(path.join(dist,'devices/device-store.js'));
const {RuntimeArtifacts}=require(path.join(dist,'runtime-artifacts/runtime-artifacts.js'));
const {AssetSourcesService}=require(path.join(dist,'asset-sources/asset-sources.service.js'));
const {PackageBuildService}=require(path.join(dist,'package-build/package-build.service.js'));
const access=new AccessDb(),devices=new DeviceStore(access),runtime=new RuntimeArtifacts(devices);
const catalog={ensureSchema:async()=>{}};
const sources=new AssetSourcesService(catalog,access,runtime),service=new PackageBuildService(access,runtime,catalog,sources);
const actor={email:process.env.TOOL_BUILD_TEST_ACTOR,activeRole:'Главный админ'};
const safe=error=>String(error?.message??'Worker failed').replace(/postgres(?:ql)?:\/\/\S+/gi,'[redacted database]').slice(0,1000);
let closing;
const close=()=>closing??=(async()=>{
    await service.onModuleDestroy();await sources.onApplicationShutdown();await devices.onModuleDestroy();await access.onModuleDestroy();
    if(process.connected)process.disconnect();
})();
process.on('message',message=>{
    if(message?.type==='stop'){void close().catch(error=>{process.send?.({type:'fatal',message:safe(error)});process.exitCode=1;});return;}
    if(message?.type!=='request')return;
    void(async()=>{
        try{
            const value=message.action==='create'?await service.create(actor,message.input)
                :message.action==='export'?await service.exportAsset(actor,message.input.id)
                :message.action==='target'?await service.publicationTarget(actor,message.input.kind,message.input.catalogId)
                :(()=>{throw Error('Unknown owned fixture action');})();
            process.send?.({type:'response',id:message.id,ok:true,value});
        }catch(error){process.send?.({type:'response',id:message.id,ok:false,error:{message:safe(error),status:error?.status}});}
    })();
});
process.on('SIGTERM',()=>{void close();});process.on('disconnect',()=>{void close();});
try{await access.ready();await service.onModuleInit();process.send({type:'ready',pid:process.pid});}
catch(error){process.send?.({type:'fatal',message:safe(error)});await close().catch(()=>{});process.exitCode=1;}
