import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const source=import.meta.url.endsWith('.ts')?'../../../../../services/shared/system-role-mcp.cjs':'../../shared/system-role-mcp.cjs';
const contract=createRequire(import.meta.url)(fileURLToPath(new URL(source,import.meta.url))) as typeof import('../../../../../services/shared/system-role-mcp.cjs');
export const {SYSTEM_ROLE_MCP_JOB,SYSTEM_ROLE_MCP_CAPABILITY,SYSTEM_ROLE_MCP_LIMITS,systemRoleMcpDigest,boundedMcpJson,
 normalizeRoleMcpTarget,normalizeRoleMcpSelection,normalizeRoleMcpTool,normalizeRoleMcpDiscovery,normalizeRoleMcpOutput,normalizeRoleMcpResult,roleMcpProducer,roleMcpToolKey,roleMcpCommand}=contract;
export type {RoleMcpTarget,RoleMcpSessionContext,RoleMcpCallContext,RoleMcpTool,RoleMcpOutput} from '../../../../../services/shared/system-role-mcp.cjs';
