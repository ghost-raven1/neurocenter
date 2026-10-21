import {withProjectFiles,commitChanges} from '../../bridge/installation-files.js';
import {InstallationPlan} from '../../bridge/installation-plan.js';
import {projectFolder,projectBindingId,projectInstanceId} from '../../bridge/workspace.js';
import {hash,hub} from '../../bridge/state.js';
import {PROJECT_AGENTS_NOTE,nativeProjectAgents,normalizeProjectAgentsPayload,renderProjectAgent,validateProjectAgentsResult,type ProjectAgentsPayload,type ProjectAgentsResult} from './contract.js';
import {AGENTS_RECEIPT,agentFile,agentsJournalKey,agentsPrivateProof,type AgentsReceipt} from './receipt.js';
import {agentConflict,assertAgentNamespace} from './namespace.js';
import {LEARNING_COLLECTOR_FILE,renderLearningCollector} from '../project-learning/collector-plugin.js';
import {approveProjectAgents,projectAgentMappings,type ApproveAgentCompilation} from './model-compiler.js';
import {isDeepStrictEqual} from 'node:util';
import {learningQueueRoot} from '../project-learning/observation-queue.js';

type Authorize=()=>Promise<unknown>;
type Progress=(percent:number,message:string)=>Promise<unknown>;
const stale=()=>Object.assign(new Error('Настройки агентов устарели или папка проекта изменилась. Повторите действие для текущей привязки.'),{code:'AGENTS_STALE'});

async function assertIdentity(payload:ProjectAgentsPayload,root:string):Promise<void>{
    if(await projectFolder(payload.projectId)!==root||await projectBindingId(payload.projectId)!==payload.bindingId||await projectInstanceId(payload.projectId)!==payload.instanceId)throw stale();
}

/** Apply one complete desired set through the existing project lock, CAS and crash-recoverable file journal. */
export async function configureProjectAgents(input:unknown,authorize:Authorize,progress:Progress,approve:ApproveAgentCompilation):Promise<ProjectAgentsResult>{
    const payload=normalizeProjectAgentsPayload(input);
    return withProjectFiles(payload.projectId,async root=>{
        await assertIdentity(payload,root);
        const compilation=await approveProjectAgents(payload,root,authorize,approve);payload.compilation=compilation;const nativeAgents=nativeProjectAgents(payload,compilation.mappings);
        const plan=new InstallationPlan(root),proof=await agentsPrivateProof(root,payload.projectId),raw=await plan.read(AGENTS_RECEIPT);
        if(raw!==null&&(!proof||raw!==proof.raw))throw agentConflict('Квитанция агентов изменена или принадлежит другой установке. Локальные файлы сохранены.');
        const previous=proof?.receipt;
        if(previous&&(previous.bindingId!==payload.bindingId||previous.instanceId!==payload.instanceId||previous.projectId!==payload.projectId
            ||previous.revision>payload.revision||previous.schemaVersion===2&&previous.revision===payload.revision&&previous.manifestSha256!==payload.manifestSha256))throw stale();
        const previousFiles=new Map(previous?.agents.map(agent=>[agentFile(agent.slug),agent.sha256])??[]);
        if(previous?.collector)previousFiles.set(previous.collector.path,previous.collector.sha256);
        const current=new Map<string,string|null>();
        for(const [file]of previousFiles)current.set(file,await plan.read(file));
        // A deleted .opencode can be reconnected without deleting the device; private history still owns the absent files.
        const restoringDeletedDirectory=raw===null&&!!proof&&[...current.values()].every(value=>value===null);
        if(raw===null&&proof&&!restoringDeletedDirectory)throw agentConflict('Квитанция агентов удалена, но локальные файлы остались. Сохраните их перед восстановлением.');
        for(const [file,expected]of previousFiles){
            const observed=current.get(file);
            if(!restoringDeletedDirectory&&(observed===null||observed===undefined||hash(observed)!==expected))throw agentConflict('Файл агента изменён вручную или удалён. Локальные изменения сохранены: '+file);
        }
        const slugs=[...new Set([...payload.agents.map(agent=>agent.slug),...previous?.agents.map(agent=>agent.slug)??[]])];
        const ownedSlugs=previous?.agents.map(agent=>agent.slug)??[];
        await assertAgentNamespace(plan,slugs,ownedSlugs,payload);
        const desired=new Map(nativeAgents.map(agent=>[agentFile(agent.slug),renderProjectAgent(agent)]));
        if(payload.agents.some(agent=>agent.enabled))desired.set(LEARNING_COLLECTOR_FILE,renderLearningCollector({projectId:payload.projectId,bindingId:payload.bindingId,instanceId:payload.instanceId,
            directory:root,server:hub(),queueDirectory:learningQueueRoot()}));
        for(const [file]of previousFiles)if(!desired.has(file))await plan.write(file,null);
        for(const [file,body]of desired){
            const before=await plan.read(file);
            if(before!==null&&!previousFiles.has(file))throw agentConflict('Файл агента уже существует и не управляется Нейроцентром. Локальные файлы сохранены: '+file);
            await plan.write(file,body);
        }
        const agents=compilation.agents;
        const receipt:AgentsReceipt={schemaVersion:2,compiledManifestSha256:compilation.manifestSha256,projectId:payload.projectId,bindingId:payload.bindingId,instanceId:payload.instanceId,revision:payload.revision,manifestSha256:payload.manifestSha256,agents};
        const collector=desired.get(LEARNING_COLLECTOR_FILE);if(collector)receipt.collector={path:LEARNING_COLLECTOR_FILE,sha256:hash(collector)};
        await plan.write(AGENTS_RECEIPT,JSON.stringify(receipt,null,2)+'\n');
        await progress(40,'Проверяем файлы и настройки агентов OpenCode.');
        const verify=async()=>{await authorize();await assertIdentity(payload,root);await assertAgentNamespace(plan,slugs,ownedSlugs,payload);if(!isDeepStrictEqual(await projectAgentMappings(payload,root,authorize),compilation.mappings))throw stale();await plan.verifySnapshot();};
        await verify();
        const changes=plan.changes();
        const {collector:_collector,...agentReceipt}=receipt;
        const result:ProjectAgentsResult={...agentReceipt,schemaVersion:2,compiledManifestSha256:compilation.manifestSha256,changed:changes.length>0,readiness:'configured',checkedAt:new Date().toISOString(),note:PROJECT_AGENTS_NOTE};
        validateProjectAgentsResult(result,payload);
        if(!changes.length)return {...result,...(proof?{recoveryPath:proof.recoveryPath}:{})};
        const recoveryPath=await commitChanges(root,changes,{action:'install',assetKey:agentsJournalKey(payload.projectId),manifest:payload.manifestSha256,result:result as unknown as Record<string,unknown>},{verifySnapshot:verify});
        return validateProjectAgentsResult({...result,recoveryPath},payload);
    });
}

/** Failure text contains no prompts, credentials, absolute paths or untrusted OpenCode output. */
export function projectAgentsFailureMessage(error:unknown):string{
    const code=(error as {code?:string})?.code;
    return code==='OPENCODE_AGENT_MODEL_SETUP_REQUIRED'?'Настройте модель в OpenCode выбранного компьютера и повторите применение. Прежние агенты сохранены.':code==='AGENTS_LOCAL_CONFLICT'?'Конфликт локальных агентов: чужие файлы или ручные изменения сохранены. Проверьте их перед повтором.'
        :code==='AGENTS_STALE'?'Настройки агентов устарели или папка переподключена. Обновите состояние проекта и повторите действие.'
        :'Агенты не настроены. Проверьте доступ, привязку папки и состояние моста; локальные файлы сохранены.';
}
