import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
export type {AgentMethodWorkflowPayload,AgentMethodWorkflowResult,AgentMethodFailureCode,AgentMethodCheck} from '../../../../../services/shared/agent-method-workflow.cjs';
const shared=createRequire(import.meta.url)(fileURLToPath(new URL(import.meta.url.endsWith('.ts')?'../../../../../services/shared/agent-method-workflow.cjs':'../../shared/agent-method-workflow.cjs',import.meta.url))) as typeof import('../../../../../services/shared/agent-method-workflow.cjs');
export const {AGENT_METHOD_WORKFLOW_PROTOCOL,AGENT_METHOD_WORKFLOW_CAPABILITY,AGENT_METHOD_SELECTED_AGENT_CAPABILITY,AGENT_METHOD_WORKFLOW_JOB,AGENT_METHOD_VERSIONS,normalizeAgentMethodWorkflowPayload,normalizeAgentMethodWorkflowResult,agentMethodWorkflowDigest,agentMethodWorkflowAgentIdentity}=shared;
