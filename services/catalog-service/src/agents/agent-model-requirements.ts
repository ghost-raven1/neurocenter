import {ConflictException} from '@nestjs/common';
import type {PoolClient} from 'pg';
import type {ProjectAgent,ProjectAgentModelRequirement} from '../../../shared/project-agents.cjs';
import {modelFromRow,type IModelRow} from '../models/model-history';
import {remoteModelBaseUrl} from '../models/remote-model-validation';
import {managedBinding} from '../devices/device-compatibility';
import type {Device} from '../devices/device-store';
import type {DeviceCodexCandidate,DeviceCodexSource} from '../../../shared/device-codex-inference.cjs';
import {assertLocalFeature} from '../devices/local-change-jobs';
import {DEVICE_CODEX_CAPABILITY} from '../../../shared/device-codex-inference.cjs';
import {remoteModelOptions} from '../models/remote-model-options';
import type {IRemoteConnectionRow} from '../models/remote-connection.repository';
import type {IOpenCodeModelOptions} from '../../../shared/opencode-model-scan.cjs';
type Db=Pick<PoolClient,'query'>;
/** Public setup guidance deliberately carries no private provider URL, prompt or credential. */
export function agentModelSetupRequired(agentId:string,modelId?:string):ConflictException{
    return new ConflictException({statusCode:409,code:'OPENCODE_AGENT_MODEL_SETUP_REQUIRED',agentId,...(modelId?{modelId}:{}),action:'sync-opencode-models',
        message:'Настройте эту модель в OpenCode выбранного компьютера и обновите список моделей.'});
}
/** An accessible project model is pinned without reading or decrypting its credential. */
export async function agentModelRequirements(db:Db,projectId:string,agents:ProjectAgent[],device?:Device):Promise<ProjectAgentModelRequirement[]>{
    const requirements:ProjectAgentModelRequirement[]=[];
    for(const agent of agents){
        if(!agent.enabled||!agent.model)continue;
        if(!agent.model.startsWith('neurocenter/')){requirements.push({kind:'native',agentId:agent.id,selector:agent.model});continue;}
        const id=agent.model.slice('neurocenter/'.length);
        const row=(await db.query<IModelRow>(`SELECT c.* FROM model_catalog c JOIN project_models p ON p.model_id=c.id
            WHERE c.id=$1 AND p.project_id=$2 AND c.archived_at IS NULL FOR SHARE OF c,p`,[id,projectId])).rows[0];
        if(!row)throw agentModelSetupRequired(agent.id,id);
        const model=modelFromRow(row);if(!['chat','vision'].includes(model.capability))throw agentModelSetupRequired(agent.id,id);
        if(model.runtime==='device-codex'){
            const local=(await db.query<{device_id:string;owner_email:string;source:DeviceCodexSource;semantic_sha:string;expected_candidate:DeviceCodexCandidate}>(`SELECT device_id,owner_email,source,semantic_sha,expected_candidate FROM model_device_connections WHERE model_id=$1 AND revoked_at IS NULL FOR SHARE`,[id])).rows[0];
            if(!device||!local||local.device_id!==device.id||local.owner_email!==device.email||model.verificationSha256!==local.semantic_sha)throw agentModelSetupRequired(agent.id,id);
            assertLocalFeature(device.report,DEVICE_CODEX_CAPABILITY);
            if(local.source.scope==='project'){
                const source=local.source,binding=(device.report.bindings as Array<{projectId:string;instanceId?:string}>|undefined)?.find(b=>b.projectId===projectId);
                if(source.projectId!==projectId||source.bindingId!==managedBinding(device.report,projectId)||source.instanceId!==binding?.instanceId)throw agentModelSetupRequired(agent.id,id);
            }
            requirements.push({kind:'catalog',agentId:agent.id,catalogModelId:id,modelPin:model.modelPin!,runtime:'device-codex',sourceSelector:local.expected_candidate.provider+'/'+(local.expected_candidate.configKey??local.expected_candidate.model),runtimeModel:model.model,baseUrl:local.expected_candidate.baseUrl,options:local.expected_candidate.options??{},capability:model.capability as 'chat'|'vision'});continue;
        }
        let baseUrl:string|null=null,options:IOpenCodeModelOptions={};
        if(model.runtime!=='ollama'){
            if(!model.verificationSha256)throw agentModelSetupRequired(agent.id,id);
            const connection=(await db.query<Pick<IRemoteConnectionRow,'base_url'|'options'>>(`SELECT base_url,options FROM model_remote_connections
                WHERE model_id=$1 AND semantic_sha=$2 AND revoked_at IS NULL ORDER BY revision DESC LIMIT 1 FOR SHARE`,[id,model.verificationSha256])).rows[0];
            if(!connection)throw agentModelSetupRequired(agent.id,id);
            baseUrl=remoteModelBaseUrl(connection.base_url);
            // Only safe protocol/generation metadata leaves the server; private arbitrary JSON requires local setup.
            const saved=remoteModelOptions(connection.options);
            if(Object.keys(saved.providerParameters??{}).length||saved.tokenLimitParameter==='max_completion_tokens')throw agentModelSetupRequired(agent.id,id);
            options={...(saved.temperature===undefined?{}:{temperature:saved.temperature}),...(saved.topP===undefined?{}:{topP:saved.topP}),
                ...(saved.maxOutputTokens===undefined?{}:{maxOutputTokens:saved.maxOutputTokens}),...(saved.contextWindow===undefined?{}:{contextWindow:saved.contextWindow}),
                ...(saved.apiFormat!=='responses'?{}:{apiFormat:'responses' as const}),...(saved.reasoningEffort===undefined?{}:{reasoningEffort:saved.reasoningEffort}),...(saved.store===undefined?{}:{store:saved.store})};
        }else if(!model.manifestSha256)throw agentModelSetupRequired(agent.id,id);
        requirements.push({kind:'catalog',agentId:agent.id,catalogModelId:id,modelPin:model.modelPin!,runtime:model.runtime,runtimeModel:model.model,baseUrl,options,capability:model.capability as 'chat'|'vision'});
    }
    return requirements;
}
