import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {servicePackages} from './dev-watch-plan.mjs';
import {devProcessIdentity,ownsDevProcess} from './dev-processes.mjs';
import {stopWatchGroup} from './dev-watch-owned.mjs';
import {entryGeneration,pruneWatchGenerations,writeWatchFile} from './dev-watch-files.mjs';
const orderedServices=services=>[...services.filter(service=>service.name==='flags'),...services.filter(service=>service.name!=='flags')];
export const WATCH_SERVICE_READY_TIMEOUT_MS=20000;
export async function saveWatchProcesses(root,records){const file=path.join(root,'.run/processes.json'),temporary=file+'.watch-'+process.pid;await fs.writeFile(temporary,JSON.stringify(records,null,2)+'\n',{mode:0o600});await fs.rename(temporary,file);}
/** Mutable help and prepared delivery assets belong to the original checkout, outside disposable generations. */
export function watchServiceEnvironment(root,service,environment){
    if(service.name==='gateway')return {...environment,BRIDGE_TEMPLATES_DIR:environment.BRIDGE_TEMPLATES_DIR||path.join(root,'bridge-dist'),NODE_TLS_REJECT_UNAUTHORIZED:environment.NODE_TLS_REJECT_UNAUTHORIZED??'0'};
    if(service.name==='catalog')return {...environment,HELP_CONTENT_DIR:environment.HELP_CONTENT_DIR||path.join(root,'services/catalog-service/content/help')};
    return environment;
}
/** Environment stays in this process; public process records contain identity and runtime paths only. */
export class WatchRuntime {
    constructor(config,guardian){this.config=config;this.guardian=guardian;this.active=new Map();this.closed=false;this.mcpEntry=null;}
    async persist(){const records=[this.config.watcherRecord,...[...this.active.values()].map(item=>item.record)];this.persisting=(this.persisting??Promise.resolve()).then(()=>saveWatchProcesses(this.config.root,records));await this.persisting;}
    async launch(service,entry,environment){
        if(this.closed)throw Error('WATCH_STOPPED');environment=watchServiceEnvironment(this.config.root,service,environment);const logFile=path.join(this.config.logDir,'neurocenter-'+service.name+'.log'),log=await fs.open(logFile,'a',0o600);
        let child;try{child=spawn(this.config.node,[path.join(this.config.root,'scripts/workspace/dev-watch-child.mjs')],{cwd:path.join(this.config.root,service.dir),env:{PATH:path.dirname(this.config.node)+path.delimiter+'/usr/bin:/bin'},detached:true,stdio:['ignore',log.fd,log.fd,'ipc']});await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});}finally{await log.close();}
        const record={name:service.name,pid:child.pid,identity:devProcessIdentity(child.pid),entry,...this.mcpEntry&&servicePackages[service.name]?{mcpEntry:this.mcpEntry}:{}};
        if(!record.identity){child.kill('SIGKILL');throw Error('WATCH_PROCESS_IDENTITY');}
        this.guardian({kind:'group',record:{pid:record.pid,identity:record.identity}});child.send({kind:'run',args:[entry],environment});this.active.set(service.name,{service,child,record,environment});await this.persist();return this.active.get(service.name);
    }
    /** Consumers start only after the selected flag definitions and preceding backend services are ready. */
    async start(generation,signal){this.mcpEntry=path.join(generation.repository,'mcp/neurocenter-asset-sync/dist/index.js');
        for(const service of orderedServices(this.config.services)){signal?.throwIfAborted();const pkg=servicePackages[service.name],entry=pkg?path.join(generation.repository,service.dir,'dist/main.js'):service.entry;
            const item=await this.launch(service,entry,{...service.environment,...pkg?{ASSET_SYNC_MCP_BIN:this.mcpEntry}:{}});if(pkg)await this.ready(item,signal);}
    }
    async stopOne(item){
        if(!item)return;if(devProcessIdentity(item.record.pid)&&!ownsDevProcess(item.record,this.config.root,item.service))throw Error('WATCH_PROCESS_OWNERSHIP');
        await stopWatchGroup(item.record);this.guardian({kind:'release',pid:item.record.pid});this.active.delete(item.service.name);await this.persist();
    }
    async ready(item,signal){const deadline=Date.now()+WATCH_SERVICE_READY_TIMEOUT_MS;while(Date.now()<deadline){signal?.throwIfAborted();if(this.closed)throw Error('WATCH_STOPPED');if(item.child.exitCode!==null||item.child.signalCode!==null)throw Error('WATCH_SERVICE_EXITED');
            try{const response=await fetch('http://127.0.0.1:'+item.service.port+(item.service.healthPath||'/health'),{signal:signal?AbortSignal.any([signal,AbortSignal.timeout(1000)]):AbortSignal.timeout(1000)});if(response.ok&&(await response.json()).ok===true)return;}catch(error){if(signal?.aborted)throw error;}await delay(150);}
        throw Error('WATCH_SERVICE_NOT_READY');
    }
    async publish(generation,selection,signal){
        const selected=new Set(selection.map(([id])=>id)),previousMcp=this.mcpEntry;if(selected.has('bridge'))this.mcpEntry=path.join(generation.repository,'mcp/neurocenter-asset-sync/dist/index.js');
        try{for(const service of orderedServices(this.config.services)){if(!selected.has(servicePackages[service.name]))continue;signal?.throwIfAborted();const previous=this.active.get(service.name);await this.stopOne(previous);let next;
                try{next=await this.launch(service,path.join(generation.repository,service.dir,'dist/main.js'),{...service.environment,ASSET_SYNC_MCP_BIN:this.mcpEntry});await this.ready(next,signal);}
                catch(error){if(next)await this.stopOne(next);if(previous&&!this.closed&&!signal?.aborted){const restored=await this.launch(service,previous.record.entry,previous.environment);await this.ready(restored,signal);}throw error;}
            }
        }catch(error){if(selected.has('bridge'))this.mcpEntry=previousMcp;throw error;}
        await this.prune();
    }
    async prune(){const keep=new Set();for(const item of this.active.values())for(const entry of [item.record.entry,item.record.mcpEntry]){const id=entryGeneration(this.config.root,entry);if(id)keep.add(id);}const mcp=entryGeneration(this.config.root,this.mcpEntry);if(mcp)keep.add(mcp);await pruneWatchGenerations(this.config.root,keep);}
    async close(){this.closed=true;const result=await Promise.allSettled([...this.active.values()].map(item=>this.stopOne(item)));if(result.some(item=>item.status==='rejected'))throw Error('WATCH_PROCESS_CLEANUP_FAILED');await this.persist();await pruneWatchGenerations(this.config.root,new Set());await writeWatchFile(this.config.root,'status.json',{schemaVersion:1,phase:'stopped',pid:this.config.watcherRecord.pid});}
}
