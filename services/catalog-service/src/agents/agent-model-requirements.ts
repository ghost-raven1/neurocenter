import {ConflictException} from '@nestjs/common';
import type {PoolClient} from 'pg';
import type {ProjectAgent,ProjectAgentModelRequirement} from '../../../shared/project-agents.cjs';
import {modelFromRow,type IModelRow} from '../models/model-history';
import {remoteModelBaseUrl} from '../models/remote-model-validation';
import {remoteModelOptions} from '../models/remote-model-options';
import type {IRemoteConnectionRow} from '../models/remote-connection.repository';
type Db=Pick<PoolClient,'query'>;
/** Public setup guidance deliberately carries no private provider URL, prompt or credential. */
export function agentModelSetupRequired(agentId:string,modelId?:string):ConflictException{
    return new ConflictException({statusCode:409,code:'OPENCODE_AGENT_MODEL_SETUP_REQUIRED',agentId,...(modelId?{modelId}:{}),action:'sync-opencode-models',
        message:'Настройте эту модель в OpenCode выбранного компьютера и обновите список моделей.'});
}
/** An accessible project model is pinned without reading or decrypting its credential. */
export async function agentModelRequirements(db:Db,projectId:string,agents:ProjectAgent[]):Promise<ProjectAgentModelRequirement[]>{
    const requirements:ProjectAgentModelRequirement[]=[];
    for(const agent of agents){
        if(!agent.enabled||!agent.model)continue;
        if(!agent.model.startsWith('neurocenter/')){requirements.push({kind:'native',agentId:agent.id,selector:agent.model});continue;}
        const id=agent.model.slice('neurocenter/'.length);
        const row=(await db.query<IModelRow>(`SELECT c.* FROM model_catalog c JOIN project_models p ON p.model_id=c.id
            WHERE c.id=$1 AND p.project_id=$2 AND c.archived_at IS NULL FOR SHARE OF c,p`,[id,projectId])).rows[0];
        if(!row)throw agentModelSetupRequired(agent.id,id);
        const model=modelFromRow(row);if(!['chat','vision'].includes(model.capability))throw agentModelSetupRequired(agent.id,id);
        let baseUrl:string|null=null,options:Record<string,number>={};
        if(model.runtime!=='ollama'){
            if(!model.verificationSha256)throw agentModelSetupRequired(agent.id,id);
            const connection=(await db.query<Pick<IRemoteConnectionRow,'base_url'|'options'>>(`SELECT base_url,options FROM model_remote_connections
                WHERE model_id=$1 AND semantic_sha=$2 AND revoked_at IS NULL ORDER BY revision DESC LIMIT 1 FOR SHARE`,[id,model.verificationSha256])).rows[0];
            if(!connection)throw agentModelSetupRequired(agent.id,id);
            baseUrl=remoteModelBaseUrl(connection.base_url);options={...remoteModelOptions(connection.options)};
        }else if(!model.manifestSha256)throw agentModelSetupRequired(agent.id,id);
        requirements.push({kind:'catalog',agentId:agent.id,catalogModelId:id,modelPin:model.modelPin!,runtime:model.runtime,runtimeModel:model.model,baseUrl,options,capability:model.capability as 'chat'|'vision'});
    }
    return requirements;
}
