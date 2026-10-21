import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const source=import.meta.url.endsWith('.ts')?'../../../../../services/shared/project-agents.cjs':'../../shared/project-agents.cjs';
const shared=createRequire(import.meta.url)(fileURLToPath(new URL(source,import.meta.url))) as typeof import('../../../../../services/shared/project-agents.cjs');
export const {PROJECT_AGENTS_CAPABILITY,PROJECT_AGENTS_JOB,PROJECT_AGENTS_NOTE,AGENT_PERMISSION_KEYS,normalizeAgentDefinition,agentDefinitionDigest,
    createProjectAgentsPayload,normalizeProjectAgentsPayload,renderProjectAgent,validateProjectAgentsResult,compileProjectAgents,nativeProjectAgents}=shared;
export type {AgentDefinition,ProjectAgent,ProjectAgentsPayload,ProjectAgentReceipt,ProjectAgentsResult,ProjectAgentsCompilation,ProjectAgentModelRequirement,ProjectAgentModelMapping} from '../../../../../services/shared/project-agents.cjs';
