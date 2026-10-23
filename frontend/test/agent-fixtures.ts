import type { IAgentCatalog, IAgentCatalogProps, IAgentDelivery, ICatalogAgent, IProjectAgent } from '../src/features/AgentCatalog/types';

export const agent = (changes: Partial<ICatalogAgent> = {}): ICatalogAgent => ({
    id:'agent-review',slug:'nc-reviewer',name:'Ревьюер',description:'Проверяет изменения',version:1,manifest:'a'.repeat(64),archivedAt:null,createdAt:'2026-10-21',updatedAt:'2026-10-21',
    definition:{description:'Проверяет изменения',prompt:'# Инструкции\nПроверяй изменения.',mode:'subagent',permission:{read:'allow',edit:'ask'}},...changes,
});
export const assignment = (changes: Partial<IProjectAgent> = {}): IProjectAgent => ({ agentId:agent().id,version:1,manifest:agent().manifest,card:agent(),effective:agent().definition,overrides:{},enabled:false,removed:false,...changes });
export const target = {deviceId:'device-one',expectedBindingId:'b'.repeat(64),expectedInstanceId:'11111111-1111-4111-8111-111111111111'};
export const delivery = (changes: Partial<IAgentDelivery> = {}): IAgentDelivery => ({
    ...target,bindingId:target.expectedBindingId,instanceId:target.expectedInstanceId,jobId:'job-one',state:'succeeded',revision:3,manifestSha256:'c'.repeat(64),message:'Настройки записаны',createdAt:'2026-10-21',updatedAt:'2026-10-21',
    result:{schemaVersion:2,compiledManifestSha256:'d'.repeat(64),projectId:'project-one',bindingId:target.expectedBindingId,instanceId:target.expectedInstanceId,revision:3,manifestSha256:'c'.repeat(64),readiness:'configured',agents:[{id:agent().id,slug:agent().slug,version:1,enabled:false,sha256:'d'.repeat(64)}]},...changes,
});
export const catalog = (changes: Partial<IAgentCatalog> = {}): IAgentCatalog => ({items:[agent()],assignments:[assignment()],revision:3,deliveries:[],...changes});
export const bridge = (): IAgentCatalogProps['bridge'] => ({
    device:{id:target.deviceId,name:'Компьютер',role:'Админ проекта',online:true,report:{protocolVersion:2,capabilities:['durable-completions','managed-installations','project-agents-v2'],bindings:[{projectId:'project-one',bindingId:target.expectedBindingId,instanceId:target.expectedInstanceId,valid:true}]}},
    jobs:[],devicesReady:true,jobsReady:true,errors:{},reload:async()=>undefined,
} as IAgentCatalogProps['bridge']);
