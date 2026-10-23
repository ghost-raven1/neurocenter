import {PROJECT_CHAT_SCHEMA_CONTRACT} from '../project-chat/project-chat.schema-contract';
import {assertProjectChatSchema} from '../project-chat/project-chat.schema-verification';
import {MODEL_RATE_LIMITS_SCHEMA_CONTRACT} from '../model-rate-limits/model-rate-limits.schema-contract';
import {assertModelRateLimitsSchema} from '../model-rate-limits/model-rate-limits.schema-verification';
import {DISCUSSIONS_SCHEMA_CONTRACT} from '../discussions/discussions.schema-contract';
import {assertDiscussionsSchema} from '../discussions/discussions.schema-verification';
import {assertChatResearchSchema,CHAT_RESEARCH_CURRENT_SCHEMA_CONTRACT} from '../model-chat/chat-research.schema-verification';
import {AGENT_READINESS_SCHEMA_CONTRACT} from '../agent-readiness/agent-readiness.schema-contract';
import {assertAgentReadinessSchema} from '../agent-readiness/agent-readiness.schema-verification';
import type {Pool} from 'pg';
import {assertCurrentBuildCatalogSchema,CURRENT_BUILD_CATALOG_SCHEMA_CONTRACT} from '../package-build/package-build-cancellation.schema-verification';
import {assertAgentSchema} from '../agents/agent-schema-verification';
import {AGENT_SCHEMA_CONTRACT} from '../agents/agent-schema-contract';
import {CATALOG_REQUEST_SCHEMA_CONTRACT} from '../catalog-requests/request.schema-contract';
import {assertCatalogRequestSchema} from '../catalog-requests/request.schema-verification';
import {BRIDGE_SOURCE_SCHEMA_CONTRACT} from '../asset-sources/bridge-source.schema-contract';
import {assertBridgeSourceSchema} from '../asset-sources/bridge-source.schema-verification';
import {LEARNING_SCHEMA_CONTRACT} from '../learning/learning-schema-contract';
import {assertLearningSchema} from '../learning/learning-schema-verification';
import {LEARNING_ANALYSIS_SCHEMA_CONTRACT} from '../learning/learning-analysis-schema-contract';
import {assertLearningAnalysisSchema} from '../learning/learning-analysis-schema-verification';
import {SOURCE_ARCHIVE_SCHEMA_CONTRACT} from '../asset-sources/source-archive.schema-contract';
import {assertSourceArchiveSchema} from '../asset-sources/source-archive.schema-verification';
import {REMOTE_OPTIONS_SCHEMA_CONTRACT} from '../models/remote-options.schema-contract';
import {assertRemoteOptionsSchema} from '../models/remote-options.schema-verification';
import {assertChatStorageSchema,CHAT_STORAGE_CURRENT_SCHEMA_CONTRACT} from '../model-chat/chat-storage.schema-verification';
import {OPENCODE_MODEL_SYNC_SCHEMA_CONTRACT} from '../models/opencode-model-sync.schema-contract';
import {assertOpenCodeModelSyncSchema} from '../models/opencode-model-sync.schema-verification';
export const CURRENT_CATALOG_SCHEMA_CONTRACT=[...CURRENT_BUILD_CATALOG_SCHEMA_CONTRACT,...AGENT_SCHEMA_CONTRACT,...CATALOG_REQUEST_SCHEMA_CONTRACT,...BRIDGE_SOURCE_SCHEMA_CONTRACT,...LEARNING_SCHEMA_CONTRACT,...LEARNING_ANALYSIS_SCHEMA_CONTRACT,...SOURCE_ARCHIVE_SCHEMA_CONTRACT,...REMOTE_OPTIONS_SCHEMA_CONTRACT,...CHAT_STORAGE_CURRENT_SCHEMA_CONTRACT,...CHAT_RESEARCH_CURRENT_SCHEMA_CONTRACT,...OPENCODE_MODEL_SYNC_SCHEMA_CONTRACT,...AGENT_READINESS_SCHEMA_CONTRACT,...DISCUSSIONS_SCHEMA_CONTRACT,...PROJECT_CHAT_SCHEMA_CONTRACT,...MODEL_RATE_LIMITS_SCHEMA_CONTRACT];
/** Runtime readiness checks every managed generation; historical migration assertions stay frozen. */
export async function assertCurrentCatalogSchema(db:Pick<Pool,'query'>):Promise<void>{
 await assertCurrentBuildCatalogSchema(db);await assertAgentSchema(db);await assertCatalogRequestSchema(db);await assertBridgeSourceSchema(db);await assertLearningSchema(db);await assertLearningAnalysisSchema(db);await assertSourceArchiveSchema(db);await assertRemoteOptionsSchema(db);await assertChatStorageSchema(db);await assertOpenCodeModelSyncSchema(db);await assertChatResearchSchema(db);await assertAgentReadinessSchema(db);await assertDiscussionsSchema(db);await assertProjectChatSchema(db);await assertModelRateLimitsSchema(db);
}
