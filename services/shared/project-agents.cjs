'use strict';
const {createHash}=require('node:crypto');

const PROJECT_AGENTS_CAPABILITY='project-agents-v2';
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
    if(agent.model?.startsWith('neurocenter/'))fail();
    if(agent.model!==undefined)header.model=agent.model;
    if(agent.temperature!==undefined)header.temperature=agent.temperature;
    if(agent.topP!==undefined)header.top_p=agent.topP;
    if(agent.steps!==undefined)header.steps=agent.steps;
    return '---\n'+JSON.stringify(header,null,2)+'\n---\n\n'+agent.prompt+'\n';
}

const resultAgents=agents=>agents.map(agent=>({id:agent.id,slug:agent.slug,version:agent.version,enabled:agent.enabled,sha256:digest(renderProjectAgent(agent))}));

function payloadBody(value){
    if(!exact(value,['schemaVersion','projectId','bindingId','instanceId','revision','agents'],['modelRequirements'])||value.schemaVersion!==2||!identity(value.projectId)
        ||typeof value.bindingId!=='string'||!SHA.test(value.bindingId)||typeof value.instanceId!=='string'||!UUID.test(value.instanceId)
        ||!positive(value.revision)||!Array.isArray(value.agents)||value.agents.length>32)fail();
    const agents=value.agents.map(normalizeProjectAgent).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
    if(new Set(agents.map(agent=>agent.id)).size!==agents.length||new Set(agents.map(agent=>agent.slug)).size!==agents.length)fail();
    const modelRequirements=normalizeModelRequirements(value.modelRequirements??[],agents);
    const body={schemaVersion:2,projectId:value.projectId,bindingId:value.bindingId,instanceId:value.instanceId,revision:value.revision,agents,modelRequirements};
    if(Buffer.byteLength(JSON.stringify(body))>2*1024*1024||Buffer.byteLength(JSON.stringify(agents.map(agent=>({id:agent.id,slug:agent.slug,version:agent.version,enabled:agent.enabled,sha256:'0'.repeat(64)}))))>8000)fail();
    return body;
}

/** The complete desired project set is pinned to one revision and one exact workspace instance. */
function createProjectAgentsPayload(value){const body=payloadBody(value),payload={...body,manifestSha256:digest(body)};
    if(Buffer.byteLength(JSON.stringify(payload))>2*1024*1024)fail();return payload;}

function normalizeProjectAgentsPayload(value){
    if(!exact(value,['schemaVersion','projectId','bindingId','instanceId','revision','agents','modelRequirements','manifestSha256'],['compilation'])
        ||typeof value.manifestSha256!=='string'||!SHA.test(value.manifestSha256))fail();
    const {manifestSha256,compilation,...body}=value,normalized=createProjectAgentsPayload(body);
    if(manifestSha256!==normalized.manifestSha256)fail();
    if(compilation!==undefined){const expected=compileProjectAgents(normalized,compilation.mappings);if(JSON.stringify(canonical(expected))!==JSON.stringify(canonical(compilation)))fail();normalized.compilation=expected;}
    return normalized;
}

/** Receipts prove the exact desired bytes, including disabled agents; they never claim completed inference. */
function validateProjectAgentsResult(value,payload){
    const source=normalizeProjectAgentsPayload(payload);
    if(!exact(value,['schemaVersion','projectId','bindingId','instanceId','revision','manifestSha256','compiledManifestSha256','agents','changed','readiness','checkedAt','note'],['recoveryPath'])
        ||value.schemaVersion!==2||!source.compilation||value.compiledManifestSha256!==source.compilation.manifestSha256||value.projectId!==source.projectId||value.bindingId!==source.bindingId||value.instanceId!==source.instanceId||value.revision!==source.revision
        ||value.manifestSha256!==source.manifestSha256||typeof value.changed!=='boolean'||value.readiness!=='configured'||value.note!==PROJECT_AGENTS_NOTE
        ||typeof value.checkedAt!=='string'||!Number.isFinite(Date.parse(value.checkedAt))||new Date(value.checkedAt).toISOString()!==value.checkedAt
        ||JSON.stringify(canonical(value.agents))!==JSON.stringify(canonical(source.compilation.agents))
        ||value.recoveryPath!==undefined&&!text(value.recoveryPath,4096)
        ||Buffer.byteLength(JSON.stringify(value))>10000)fail();
    return canonical(value);
}

/** Safe protocol/generation metadata only; private JSON, credentials and file references stay outside compilations. */
function normalizeModelOptions(value){
    if(!require('./opencode-model-scan.cjs').validModelOptions(value))fail();
    return canonical(value);
}
function nativeSelector(value){return text(value,200)&&/^[a-zA-Z0-9][a-zA-Z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(value)&&!value.startsWith('neurocenter/');}
function normalizeModelRequirements(value,agents){
    if(!Array.isArray(value)||value.length>32)fail();
    const result=value.map(item=>{
        if(!record(item)||!identity(item.agentId)||!agents.some(agent=>agent.id===item.agentId&&agent.enabled&&agent.model))fail();
        if(item.kind==='native'){if(!exact(item,['kind','agentId','selector'])||!nativeSelector(item.selector)||agents.find(agent=>agent.id===item.agentId).model!==item.selector)fail();}
        else if(item.kind==='catalog'){
            if(!exact(item,['kind','agentId','catalogModelId','modelPin','runtime','runtimeModel','baseUrl','options','capability'])||!identity(item.catalogModelId)||typeof item.modelPin!=='string'||!SHA.test(item.modelPin)
                ||!['remote-openai','remote-ollama','ollama'].includes(item.runtime)||!text(item.runtimeModel,200)||!['chat','vision'].includes(item.capability)
                ||agents.find(agent=>agent.id===item.agentId).model!=='neurocenter/'+item.catalogModelId)fail();
            if(item.baseUrl!==null){if(!text(item.baseUrl,1024))fail();let url;try{url=new URL(item.baseUrl);}catch{fail();}if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)fail();}
            normalizeModelOptions(item.options);
        }else fail();
        return canonical(item);
    }).sort((a,b)=>a.agentId.localeCompare(b.agentId));
    if(new Set(result.map(item=>item.agentId)).size!==result.length)fail();return result;
}
function normalizeModelMapping(item){
    if(!exact(item,['agentId','provider','configKey','runtime','model','baseUrl','options','capability'])||!identity(item.agentId)||typeof item.provider!=='string'||typeof item.configKey!=='string'||item.provider.length>128||item.configKey.length>128||!nativeSelector(item.provider+'/'+item.configKey)
        ||!['remote-openai','remote-ollama'].includes(item.runtime)||!text(item.model,200)||!['chat','vision'].includes(item.capability))fail();
    let url;try{url=new URL(item.baseUrl);}catch{fail();}if(!text(item.baseUrl,1024)||!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)fail();
    return {...canonical(item),options:normalizeModelOptions(item.options)};
}
/** The immutable desired state remains canonical; only approved native selectors reach OpenCode files. */
function compileProjectAgents(payload,value){
    const {compilation:_compilation,...raw}=payload,source=normalizeProjectAgentsPayload(raw);
    if(!Array.isArray(value)||value.length!==source.modelRequirements.length)fail();
    const mappings=value.map(normalizeModelMapping).sort((a,b)=>a.agentId.localeCompare(b.agentId));
    if(new Set(mappings.map(item=>item.agentId)).size!==mappings.length)fail();
    for(const requirement of source.modelRequirements){
        const mapping=mappings.find(item=>item.agentId===requirement.agentId);if(!mapping)fail();
        if(requirement.kind==='native'){if(mapping.provider+'/'+mapping.configKey!==requirement.selector)fail();}
        else if(mapping.runtime!==requirement.runtime||mapping.model!==requirement.runtimeModel||mapping.baseUrl!==requirement.baseUrl||mapping.capability!==requirement.capability
            ||JSON.stringify(canonical(mapping.options))!==JSON.stringify(canonical(requirement.options)))fail();
    }
    const agents=nativeProjectAgents(source,mappings);
    const body={schemaVersion:2,payloadManifest:source.manifestSha256,mappings,agents:resultAgents(agents)};
    const compilation={...body,manifestSha256:digest(body)};if(Buffer.byteLength(JSON.stringify({...source,compilation}))>2*1024*1024)fail();return compilation;
}
/** Rebuild native bytes from canonical source plus exact approved mappings; no prompt duplication in the job. */
function nativeProjectAgents(source,mappings){
    return source.agents.map(agent=>{
        const compiled={...agent},mapping=mappings.find(item=>item.agentId===agent.id);
        if(!agent.enabled){delete compiled.model;return compiled;}
        if(agent.model&&!mapping)fail();if(mapping)compiled.model=mapping.provider+'/'+mapping.configKey;return compiled;
    });
}


module.exports={PROJECT_AGENTS_CAPABILITY,PROJECT_AGENTS_JOB,PROJECT_AGENTS_NOTE,AGENT_PERMISSION_KEYS,normalizeAgentDefinition,agentDefinitionDigest,
    createProjectAgentsPayload,normalizeProjectAgentsPayload,renderProjectAgent,validateProjectAgentsResult,compileProjectAgents,nativeProjectAgents};
