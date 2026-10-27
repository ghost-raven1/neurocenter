import type {AgentMethod,AgentMethodWorkflowAgentIdentity,AgentMethodWorkflowResult} from '../../../../services/shared/agent-method-workflow.cjs';
import type {IBridgeJobInput} from '../McpBridge/api';

export const methodLabels:Record<AgentMethod,string>={bmad:'BMAD',openspec:'OpenSpec',combined:'BMAD → OpenSpec'};
export const WORKFLOW_INPUT_MAX_BYTES=16384;
export type WorkflowIntent=Extract<IBridgeJobInput,{kind:'run-agent-method-workflow'}>;
export interface WorkflowDraft {method:AgentMethod;instruction:string;checks:string[];agentId?:string;pending?:WorkflowIntent;rejectedStatus?:400|409;}
export const emptyWorkflowDraft=():WorkflowDraft=>({method:'openspec',instruction:'',checks:['typecheck','test']});
export const workflowStorageKey=(scope:string,projectId:string):string=>'neurocenter.agent-method-workflow.'+JSON.stringify([scope,projectId]);
export const workflowChecks=(checks:string[])=>checks.map(check=>({command:'npm',args:check==='test'?['test']:['run',check]}));
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const agentId=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value);
const revision=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>0;

function validPending(value:WorkflowDraft,projectId?:string):boolean{
    const pending=value.pending!;
    if(!pending||Object.keys(pending).some(key=>!['kind','projectId','deviceId','requestKey','expectedBindingId','expectedInstanceId','workflow'].includes(key))
        ||pending.kind!=='run-agent-method-workflow'||!uuid(pending.requestKey)||!uuid(pending.expectedInstanceId)
        ||typeof pending.expectedBindingId!=='string'||!/^[a-f0-9]{64}$/.test(pending.expectedBindingId)
        ||typeof pending.deviceId!=='string'||!pending.deviceId||pending.deviceId.length>200||/[\x00-\x1f]/.test(pending.deviceId)
        ||typeof pending.projectId!=='string'||!pending.projectId||projectId!==undefined&&pending.projectId!==projectId
        ||!pending.workflow||Object.keys(pending.workflow).some(key=>!['method','instruction','checks','agentId','expectedAgentsRevision'].includes(key))
        ||pending.workflow.method!==value.method||pending.workflow.instruction!==value.instruction||new TextEncoder().encode(pending.workflow.instruction).length>WORKFLOW_INPUT_MAX_BYTES
        ||!value.checks.length||!Array.isArray(pending.workflow.checks))return false;
    if(pending.workflow.agentId===undefined?value.agentId!==undefined||pending.workflow.expectedAgentsRevision!==undefined
        :!agentId(pending.workflow.agentId)||pending.workflow.agentId!==value.agentId||!revision(pending.workflow.expectedAgentsRevision))return false;
    const expected=workflowChecks(value.checks);
    return pending.workflow.checks.length===expected.length&&pending.workflow.checks.every((check,index)=>check&&Object.keys(check).every(key=>['command','args'].includes(key))
        &&check.command===expected[index].command&&Array.isArray(check.args)&&check.args.length===expected[index].args.length&&check.args.every((arg,position)=>arg===expected[index].args[position]));
}

/** A malformed recovery record blocks a new dispatch instead of silently losing a possibly accepted intent. */
export function readWorkflowDraft(storage:Pick<Storage,'getItem'>,key:string,projectId?:string):WorkflowDraft{
    const raw=storage.getItem(key);if(!raw)return emptyWorkflowDraft();
    if(raw.length>100000)throw Error('Сохранённая задача слишком велика. Проверьте историю заданий перед новой отправкой.');
    const value=JSON.parse(raw) as WorkflowDraft;
    if(!value||!Object.prototype.hasOwnProperty.call(methodLabels,value.method)||typeof value.instruction!=='string'||new TextEncoder().encode(value.instruction).length>65536
        ||!Array.isArray(value.checks)||value.checks.some(item=>!['typecheck','test','check'].includes(item))
        ||value.agentId!==undefined&&!agentId(value.agentId)
        ||value.rejectedStatus!==undefined&&(!value.pending||![400,409].includes(value.rejectedStatus)))throw Error('Сохранённая задача не прочитана. Проверьте историю заданий перед новой отправкой.');
    if(Object.prototype.hasOwnProperty.call(value,'pending')&&!validPending(value,projectId))throw Error('Квитанция задачи повреждена. Проверьте историю заданий перед новой отправкой.');
    return value;
}

/** The server validates full results; the UI still rejects incomplete data before rendering a success. */
export function workflowResult(value:unknown,expectedAgent?:AgentMethodWorkflowAgentIdentity|null):AgentMethodWorkflowResult|undefined{
    if(!value||typeof value!=='object')return;
    const result=value as AgentMethodWorkflowResult;
    if(result.protocol!=='agent-method-workflow-v1'||!Object.prototype.hasOwnProperty.call(methodLabels,result.method)||!['succeeded','failed','cancelled','unknown','needs_setup'].includes(result.state)
        ||!Array.isArray(result.checks)||!Array.isArray(result.changes)||!Array.isArray(result.artifacts))return;
    if(result.checks.some(check=>!check||typeof check.command!=='string'||!Array.isArray(check.args)||check.args.some(arg=>typeof arg!=='string')||!['passed','failed','not_run'].includes(check.state))
        ||result.changes.some(file=>!file||typeof file.path!=='string')||result.artifacts.some(file=>!file||typeof file.path!=='string'))return;
    if(result.state==='succeeded'&&(result.stage!=='completed'||!result.checks.length
        ||result.checks.some(check=>check.state!=='passed'||check.exitCode!==0||check.signal!==null)))return;
    if(result.agent!==undefined&&!workflowAgentIdentity(result.agent)||expectedAgent&&!sameWorkflowAgent(expectedAgent,result.agent))return;
    return result;
}

/** Public identity has no model mapping, credentials or absolute project path. */
export function workflowAgentIdentity(value:unknown):AgentMethodWorkflowAgentIdentity|undefined{
    if(!value||typeof value!=='object')return;
    const item=value as AgentMethodWorkflowAgentIdentity,digest=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
    if(!agentId(item.agentId)||typeof item.slug!=='string'||!/^nc-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.slug)
        ||!revision(item.version)||!revision(item.agentsRevision)||!digest(item.agentsManifestSha256)||!digest(item.compiledManifestSha256)
        ||!digest(item.fileSha256)||typeof item.configurationJobId!=='string'||!item.configurationJobId||item.configurationJobId.length>200)return;
    return item;
}

export function sameWorkflowAgent(left:AgentMethodWorkflowAgentIdentity,right:unknown):boolean{
    const value=workflowAgentIdentity(right);
    return !!value&&(['agentId','slug','version','agentsRevision','agentsManifestSha256','compiledManifestSha256','fileSha256','configurationJobId'] as const).every(key=>left[key]===value[key]);
}

export function workflowNextAction(result:AgentMethodWorkflowResult):string{
    if(result.failure?.action==='setup-agent')return 'Примените текущие настройки агентов к выбранной папке и настройте явную модель основного агента. Затем перечитайте агентов и создайте новое задание. Задача сохранена.';
    if(result.failure?.code==='QUIRK_STORAGE_INVALID')return 'Хранилище Quirk не прошло проверку. Запуск остановлен до загрузки плагина; данные не исправлялись и не очищались. Проверьте источник знаний или восстановите проверенную копию.';
    if(result.failure?.action==='setup-method')return 'Подготовьте выбранную методику и её проектные файлы на подключённом компьютере. Введённая задача сохранена.';
    if(result.failure?.action==='setup-runtime')return 'Настройте OpenCode и модель в выбранной папке проекта, затем создайте новое задание.';
    if(result.state==='unknown')return 'Проверьте локальные изменения и журнал на компьютере. Исполнение автоматически не повторяется.';
    if(result.failure?.action==='inspect-workspace')return 'Проверьте привязанную папку и сохранённые локальные изменения перед новым заданием.';
    return 'Просмотрите изменённые файлы и результаты проверок в привязанной папке.';
}
