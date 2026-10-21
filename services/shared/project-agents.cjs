'use strict';
const {createHash}=require('node:crypto');

const PROJECT_AGENTS_CAPABILITY='project-agents-v1';
const PROJECT_AGENTS_JOB='configure-project-agents';
const PROJECT_AGENTS_NOTE='Агенты настроены. OpenCode перечитает их при следующем запуске; выполнение модели не проверялось.';
const AGENT_PERMISSION_KEYS=['read','edit','bash','glob','grep','list','task','external_directory','todowrite','question','webfetch','websearch','lsp','doom_loop','skill'];
const DEFINITION_FIELDS=['description','prompt','mode','permission','model','temperature','topP','steps'];
const SHA=/^[a-f0-9]{64}$/;
const UUID=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const fail=()=>{throw new Error('Некорректная конфигурация агентов OpenCode.');};
const record=value=>!!value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const exact=(value,required,optional=[])=>record(value)&&required.every(key=>Object.hasOwn(value,key))&&Object.keys(value).every(key=>required.includes(key)||optional.includes(key));
const canonical=value=>Array.isArray(value)?value.map(canonical):record(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const digest=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(canonical(value))).digest('hex');
const text=(value,maximum,{empty=false}={})=>typeof value==='string'&&(empty||value.trim().length>0)&&Buffer.byteLength(value,'utf8')<=maximum
    &&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)&&Buffer.from(value,'utf8').toString('utf8')===value;
const identity=value=>text(value,200)&&/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(value);
const positive=value=>Number.isSafeInteger(value)&&value>0;

/** Native OpenCode 1.14.48 uses permission.bash, not the newer shell spelling. */
function normalizeAgentDefinition(value){
    if(!exact(value,['description','prompt','mode','permission'],['model','temperature','topP','steps'])
        ||!text(value.description,1024)||/[\x00-\x1f\x7f]/.test(value.description)||!text(value.prompt,64*1024)||!['primary','subagent','all'].includes(value.mode)||!record(value.permission)
        ||Object.keys(value.permission).some(key=>!AGENT_PERMISSION_KEYS.includes(key)||!['allow','ask','deny'].includes(value.permission[key])))fail();
    if(value.model!==undefined&&(!text(value.model,200)||!/^[a-zA-Z0-9][a-zA-Z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(value.model)||value.model.includes('://')))fail();
    if(value.temperature!==undefined&&(!Number.isFinite(value.temperature)||value.temperature<0||value.temperature>2))fail();
    if(value.topP!==undefined&&(!Number.isFinite(value.topP)||value.topP<0||value.topP>1))fail();
    if(value.steps!==undefined&&(!positive(value.steps)||value.steps>1000))fail();
    return canonical(Object.fromEntries(DEFINITION_FIELDS.filter(key=>value[key]!==undefined).map(key=>[key,value[key]])));
}

function agentDefinitionDigest(value){return digest(normalizeAgentDefinition(value));}

function normalizeProjectAgent(value){
    if(!exact(value,['id','slug','version','enabled','description','prompt','mode','permission'],['model','temperature','topP','steps'])
        ||!identity(value.id)||typeof value.slug!=='string'||value.slug.length>64||!/^nc-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.slug)
        ||!positive(value.version)||typeof value.enabled!=='boolean')fail();
    return {id:value.id,slug:value.slug,version:value.version,enabled:value.enabled,...normalizeAgentDefinition(Object.fromEntries(DEFINITION_FIELDS.filter(key=>value[key]!==undefined).map(key=>[key,value[key]])))};
}

/** JSON is valid YAML: quoting every value keeps prompts and descriptions out of executable frontmatter. */
function renderProjectAgent(value){
    const agent=normalizeProjectAgent(value);
    const header={description:agent.description,mode:agent.mode,disable:!agent.enabled,permission:agent.permission};
    if(agent.model!==undefined)header.model=agent.model;
    if(agent.temperature!==undefined)header.temperature=agent.temperature;
    if(agent.topP!==undefined)header.top_p=agent.topP;
    if(agent.steps!==undefined)header.steps=agent.steps;
    return '---\n'+JSON.stringify(header,null,2)+'\n---\n\n'+agent.prompt+'\n';
}

const resultAgents=agents=>agents.map(agent=>({id:agent.id,slug:agent.slug,version:agent.version,enabled:agent.enabled,sha256:digest(renderProjectAgent(agent))}));

function payloadBody(value){
    if(!exact(value,['schemaVersion','projectId','bindingId','instanceId','revision','agents'])||value.schemaVersion!==1||!identity(value.projectId)
        ||typeof value.bindingId!=='string'||!SHA.test(value.bindingId)||typeof value.instanceId!=='string'||!UUID.test(value.instanceId)
        ||!positive(value.revision)||!Array.isArray(value.agents)||value.agents.length>32)fail();
    const agents=value.agents.map(normalizeProjectAgent).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
    if(new Set(agents.map(agent=>agent.id)).size!==agents.length||new Set(agents.map(agent=>agent.slug)).size!==agents.length)fail();
    const body={schemaVersion:1,projectId:value.projectId,bindingId:value.bindingId,instanceId:value.instanceId,revision:value.revision,agents};
    if(Buffer.byteLength(JSON.stringify(body))>2*1024*1024||Buffer.byteLength(JSON.stringify(resultAgents(agents)))>8000)fail();
    return body;
}

/** The complete desired project set is pinned to one revision and one exact workspace instance. */
function createProjectAgentsPayload(value){const body=payloadBody(value),payload={...body,manifestSha256:digest(body)};
    if(Buffer.byteLength(JSON.stringify(payload))>2*1024*1024)fail();return payload;}

function normalizeProjectAgentsPayload(value){
    if(!exact(value,['schemaVersion','projectId','bindingId','instanceId','revision','agents','manifestSha256'])
        ||typeof value.manifestSha256!=='string'||!SHA.test(value.manifestSha256))fail();
    const {manifestSha256,...body}=value,normalized=createProjectAgentsPayload(body);
    if(manifestSha256!==normalized.manifestSha256)fail();return normalized;
}

/** Receipts prove the exact desired bytes, including disabled agents; they never claim completed inference. */
function validateProjectAgentsResult(value,payload){
    const source=normalizeProjectAgentsPayload(payload);
    if(!exact(value,['schemaVersion','projectId','bindingId','instanceId','revision','manifestSha256','agents','changed','readiness','checkedAt','note'],['recoveryPath'])
        ||value.schemaVersion!==1||value.projectId!==source.projectId||value.bindingId!==source.bindingId||value.instanceId!==source.instanceId||value.revision!==source.revision
        ||value.manifestSha256!==source.manifestSha256||typeof value.changed!=='boolean'||value.readiness!=='configured'||value.note!==PROJECT_AGENTS_NOTE
        ||typeof value.checkedAt!=='string'||!Number.isFinite(Date.parse(value.checkedAt))||new Date(value.checkedAt).toISOString()!==value.checkedAt
        ||JSON.stringify(canonical(value.agents))!==JSON.stringify(canonical(resultAgents(source.agents)))
        ||value.recoveryPath!==undefined&&!text(value.recoveryPath,4096)
        ||Buffer.byteLength(JSON.stringify(value))>10000)fail();
    return canonical(value);
}

module.exports={PROJECT_AGENTS_CAPABILITY,PROJECT_AGENTS_JOB,PROJECT_AGENTS_NOTE,AGENT_PERMISSION_KEYS,normalizeAgentDefinition,agentDefinitionDigest,
    createProjectAgentsPayload,normalizeProjectAgentsPayload,renderProjectAgent,validateProjectAgentsResult};
