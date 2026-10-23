import {isDeepStrictEqual} from 'node:util';
import {readOpenCodeModelMetadata} from '../../bridge/opencode-model-scan.js';
import {hasUnsafeOpenCodeWarnings} from '../../bridge/opencode-scan-warnings.js';
import {compileProjectAgents,type ProjectAgentsPayload,type ProjectAgentModelMapping,type ProjectAgentsCompilation} from './contract.js';
export type ApproveAgentCompilation=(mappings:ProjectAgentModelMapping[])=>Promise<unknown>;
const setup=(agentId:string,modelId?:string)=>Object.assign(new Error('Настройте модель агента в OpenCode выбранного компьютера и повторите применение.'),
    {code:'OPENCODE_AGENT_MODEL_SETUP_REQUIRED',agentId,...(modelId?{modelId}:{}),action:'sync-opencode-models'});
/** Private preparation reads effective metadata, never auth.json, key references, SDKs or provider APIs. */
export async function projectAgentMappings(payload:ProjectAgentsPayload,root:string,authorize:()=>Promise<unknown>):Promise<ProjectAgentModelMapping[]>{
    if(!payload.modelRequirements.length)return [];
    const scan=await readOpenCodeModelMetadata(root,{scope:'project',projectId:payload.projectId,bindingId:payload.bindingId,instanceId:payload.instanceId},
        {authorize,readAuth:false,requestedSelectors:payload.modelRequirements.filter(item=>item.kind==='native').map(item=>item.selector)});
    if(hasUnsafeOpenCodeWarnings(scan.warnings))throw setup(payload.modelRequirements[0]!.agentId);
    return payload.modelRequirements.map(requirement=>{
        const deviceCodex=requirement.kind==='catalog'&&requirement.runtime==='device-codex';
        const matches=scan.candidates.filter(candidate=>(!candidate.blocker||requirement.kind==='native'&&['codex-local-auth','local-provider-auth','device-local-endpoint'].includes(candidate.blocker)
                ||deviceCodex&&candidate.blocker==='codex-local-auth'
                ||requirement.kind==='catalog'&&requirement.runtime==='remote-ollama'&&candidate.runtime==='remote-ollama'&&/^neurocenter-ollama-[a-f0-9]{16}$/.test(candidate.provider)&&candidate.blocker==='device-local-endpoint')&&candidate.runtime&&candidate.baseUrl
            &&(requirement.kind==='native'?candidate.provider+'/'+(candidate.configKey??candidate.model)===requirement.selector
                :candidate.runtime===(deviceCodex?'remote-openai':requirement.runtime)&&(!deviceCodex||candidate.provider+'/'+(candidate.configKey??candidate.model)===requirement.sourceSelector)
                    &&candidate.model===requirement.runtimeModel&&candidate.baseUrl===requirement.baseUrl
                    &&candidate.capability===requirement.capability&&isDeepStrictEqual(candidate.options??{},requirement.options)));
        if(matches.length!==1)throw setup(requirement.agentId,requirement.kind==='catalog'?requirement.catalogModelId:undefined);
        const candidate=matches[0]!;return {agentId:requirement.agentId,provider:candidate.provider,configKey:candidate.configKey??candidate.model,
            runtime:candidate.runtime!,model:candidate.model,baseUrl:candidate.baseUrl!,options:{...candidate.options},capability:candidate.capability};
    });
}
/** The server's durable approval is independently reconstructed before any local file mutation. */
export async function approveProjectAgents(payload:ProjectAgentsPayload,root:string,authorize:()=>Promise<unknown>,approve:ApproveAgentCompilation):Promise<ProjectAgentsCompilation>{
    const mappings=await projectAgentMappings(payload,root,authorize),expected=compileProjectAgents(payload,mappings),approved=await approve(mappings);
    if(!isDeepStrictEqual(approved,expected))throw Object.assign(new Error('Сервер подтвердил другой набор агентов. Локальные файлы сохранены.'),{code:'AGENTS_STALE'});
    return expected;
}
/** Only this exact public setup status may cross the device channel after a preparation failure. */
export function projectAgentsFailureResult(error:unknown):Record<string,unknown>{
    const failure=error as {code?:unknown;agentId?:unknown;modelId?:unknown};
    if(failure?.code!=='OPENCODE_AGENT_MODEL_SETUP_REQUIRED'||typeof failure.agentId!=='string')return {};
    return {code:failure.code,agentId:failure.agentId,...(typeof failure.modelId==='string'?{modelId:failure.modelId}:{}),action:'sync-opencode-models'};
}
