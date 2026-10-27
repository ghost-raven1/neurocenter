'use strict';
const {createHash}=require('node:crypto');
const {normalizeProjectAgentModelMapping}=require('./project-agents.cjs');
const AGENT_METHOD_WORKFLOW_PROTOCOL='agent-method-workflow-v1';
const AGENT_METHOD_WORKFLOW_CAPABILITY=AGENT_METHOD_WORKFLOW_PROTOCOL;
const AGENT_METHOD_SELECTED_AGENT_CAPABILITY='agent-method-selected-agent-v1';
const AGENT_METHOD_WORKFLOW_JOB='run-agent-method-workflow';
const AGENT_METHOD_VERSIONS=Object.freeze({bmad:'6.12.4',openspec:'1.15.0',combined:'bmad-6.12.4+openspec-1.15.0'});
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const text=(value,max)=>typeof value==='string'&&Buffer.byteLength(value)<=max&&!/[\x00-\x1f\x7f]/.test(value);
const exact=(value,required,optional=[])=>object(value)&&required.every(key=>Object.hasOwn(value,key))&&Object.keys(value).every(key=>required.includes(key)||optional.includes(key));
const fail=()=>{throw new TypeError('Invalid agent method workflow contract.');};
const agentIdentityFields=['agentId','slug','version','agentsRevision','agentsManifestSha256','compiledManifestSha256','fileSha256','configurationJobId'];
/** Public execution identity omits prompt, model endpoint and private provider configuration. */
function agentMethodWorkflowAgentIdentity(value){
 if(!exact(value,agentIdentityFields,['mode','model'])||!text(value.agentId,200)||!value.agentId||!text(value.slug,64)||!/^nc-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.slug)
  ||!Number.isSafeInteger(value.version)||value.version<1||!Number.isSafeInteger(value.agentsRevision)||value.agentsRevision<1
  ||!sha(value.agentsManifestSha256)||!sha(value.compiledManifestSha256)||!sha(value.fileSha256)||!uuid(value.configurationJobId))fail();
 return Object.fromEntries(agentIdentityFields.map(key=>[key,value[key]]));
}
function normalizeSelectedAgent(value){
 if(!exact(value,[...agentIdentityFields,'mode','model'])||!['primary','all'].includes(value.mode))fail();
 const identity=agentMethodWorkflowAgentIdentity(value),model=normalizeProjectAgentModelMapping(value.model);
 if(model.agentId!==identity.agentId)fail();
 return {...identity,mode:value.mode,model};
}
function checkCommand(value){
 if(!exact(value,['command','args'])||!text(value.command,128)||!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value.command)
  ||!Array.isArray(value.args)||value.args.length>32||value.args.some(arg=>!text(arg,2048)))fail();
 return {command:value.command,args:[...value.args]};
}
/** Immutable accepted intent contains argv only; local environment and absolute folders never cross the wire. */
function normalizeAgentMethodWorkflowPayload(value){
 const fields=['protocol','workflowId','requestId','projectId','bindingId','instanceId','method','methodVersion','stage','instruction','deadlineAt','runtime','checks'];
 if(!exact(value,fields,['agent'])||value.protocol!==AGENT_METHOD_WORKFLOW_PROTOCOL||!uuid(value.workflowId)||!uuid(value.requestId)||!text(value.projectId,256)||!value.projectId
  ||!sha(value.bindingId)||!uuid(value.instanceId)||!Object.hasOwn(AGENT_METHOD_VERSIONS,value.method)||value.methodVersion!==AGENT_METHOD_VERSIONS[value.method]
  ||value.stage!=='full-cycle'||typeof value.instruction!=='string'||!value.instruction.trim()||Buffer.byteLength(value.instruction)>16384||value.instruction.includes('\0')
  ||!text(value.deadlineAt,40)||!Number.isFinite(Date.parse(value.deadlineAt))||value.runtime!=='opencode'||!Array.isArray(value.checks)||value.checks.length>8)fail();
 if(Buffer.byteLength(JSON.stringify(value))>32768)fail();
 return {...Object.fromEntries(fields.map(key=>[key,key==='checks'?value.checks.map(checkCommand):value[key]])),...(Object.hasOwn(value,'agent')?{agent:normalizeSelectedAgent(value.agent)}:{})};
}
const failureCodes=['METHOD_MISSING','METHOD_VERSION','PROJECT_NOT_INITIALIZED','METHOD_WORKFLOW_MISSING','RUNTIME_MISSING','CHECKS_REQUIRED','UNSUPPORTED_PLATFORM',
 'EXECUTION_FAILED','CHECK_FAILED','AUTHORIZATION_LOST','UNKNOWN_OUTCOME','CANCELLED','OUTPUT_LIMIT','TIMEOUT','WORKSPACE_CHANGED','OBSERVATION_LIMIT','QUIRK_STORAGE_INVALID','SELECTED_AGENT_NOT_READY'];
const relative=value=>text(value,256)&&!!value&&!value.startsWith('/')&&!value.includes('\\')&&!value.split('/').some(part=>!part||part==='.'||part==='..');
/** Results report observed file hashes and real command exits, never model prose or captured stdout. */
function normalizeAgentMethodWorkflowResult(value,payload){
 const fields=['protocol','workflowId','method','methodVersion','runtime','state','stage','codeChanged','changes','artifacts','checks'];
 if(!exact(value,fields,['failure','agent'])||value.protocol!==AGENT_METHOD_WORKFLOW_PROTOCOL||!uuid(value.workflowId)||!Object.hasOwn(AGENT_METHOD_VERSIONS,value.method)
  ||value.methodVersion!==AGENT_METHOD_VERSIONS[value.method]||value.runtime!=='opencode'||!['succeeded','failed','cancelled','unknown','needs_setup'].includes(value.state)
  ||!['prerequisites','execution','checks','completed'].includes(value.stage)||typeof value.codeChanged!=='boolean'||!Array.isArray(value.changes)||value.changes.length>64
  ||value.changes.some(row=>!exact(row,['path','beforeSha256','afterSha256'])||!relative(row.path)||!(row.beforeSha256===null||sha(row.beforeSha256))||!(row.afterSha256===null||sha(row.afterSha256))||row.beforeSha256===row.afterSha256)
  ||!Array.isArray(value.artifacts)||value.artifacts.length>64||value.artifacts.some(row=>!exact(row,['path','sha256'])||!relative(row.path)||!sha(row.sha256))
  ||!Array.isArray(value.checks)||value.checks.length>8||value.checks.some(row=>!exact(row,['command','args','exitCode','signal','state'])||!['passed','failed','not_run'].includes(row.state)
   ||!(row.exitCode===null||Number.isSafeInteger(row.exitCode))||!(row.signal===null||text(row.signal,32))||row.state==='passed'&&(row.exitCode!==0||row.signal!==null)
   ||row.state==='not_run'&&(row.exitCode!==null||row.signal!==null)))fail();
 for(const row of value.checks)checkCommand({command:row.command,args:row.args});
 if(value.agent!==undefined){if(!exact(value.agent,agentIdentityFields))fail();agentMethodWorkflowAgentIdentity(value.agent);}
 if(value.failure!==undefined&&(!exact(value.failure,['code','action'])||!failureCodes.includes(value.failure.code)||!['setup-method','setup-runtime','setup-agent','inspect-workspace','review-result'].includes(value.failure.action)))fail();
 if(value.state==='succeeded'&&(value.stage!=='completed'||value.failure||!value.checks.length||value.checks.some(row=>row.state!=='passed')))fail();
 if(value.state!=='succeeded'&&!value.failure)fail();
 if(Buffer.byteLength(JSON.stringify(value))>65536)fail();
 if(payload){const intent=normalizeAgentMethodWorkflowPayload(payload);
  if(value.workflowId!==intent.workflowId||value.method!==intent.method||value.methodVersion!==intent.methodVersion||JSON.stringify(value.checks.map(({command,args})=>({command,args})))!==JSON.stringify(intent.checks))fail();
  if(JSON.stringify(value.agent&&agentMethodWorkflowAgentIdentity(value.agent))!==JSON.stringify(intent.agent&&agentMethodWorkflowAgentIdentity(intent.agent)))fail();
 }
 return JSON.parse(JSON.stringify(value));
}
const agentMethodWorkflowDigest=value=>createHash('sha256').update(JSON.stringify(normalizeAgentMethodWorkflowPayload(value))).digest('hex');
module.exports={AGENT_METHOD_WORKFLOW_PROTOCOL,AGENT_METHOD_WORKFLOW_CAPABILITY,AGENT_METHOD_SELECTED_AGENT_CAPABILITY,AGENT_METHOD_WORKFLOW_JOB,AGENT_METHOD_VERSIONS,normalizeAgentMethodWorkflowPayload,normalizeAgentMethodWorkflowResult,agentMethodWorkflowDigest,agentMethodWorkflowAgentIdentity};
