import {AGENT_TOOLS_SCHEMA_SQL} from '../agent-tools/agent-tools.schema';
import {SERVICE_ROLE_CONVERSATIONS_SCHEMA_SQL} from '../system-role-chat/service-role-conversations.schema';
import {SERVICE_ROLE_CONVERSATIONS_SCHEMA_ASSERT_SQL} from '../system-role-chat/service-role-conversations.schema-verification';
import {CHAT_SUMMARY_POLICY_SCHEMA_SQL} from '../model-chat/chat-summary-policy.schema';
import {CHAT_SUMMARY_POLICY_SCHEMA_ASSERT_SQL} from '../model-chat/chat-summary-policy.schema-verification';
import {AGENT_TOOLS_SCHEMA_ASSERT_SQL} from '../agent-tools/agent-tools.schema-verification';
import {PLUGIN_AUTO_UPDATE_SCHEMA_SQL} from '../plugin-auto-updates/auto-update.schema';
import {PLUGIN_AUTO_UPDATE_SCHEMA_ASSERT_SQL} from '../plugin-auto-updates/auto-update.schema-verification';
import {CHAT_SYSTEM_ROLE_SCHEMA_SQL} from '../chat-system-roles/chat-system-roles.schema';
import {CHAT_SYSTEM_ROLE_SCHEMA_ASSERT_SQL} from '../chat-system-roles/chat-system-roles.schema-verification';
import {CHAT_SEARCH_SCHEMA_SQL} from '../chat-search/chat-search.schema';
import {CHAT_SEARCH_SCHEMA_ASSERT_SQL} from '../chat-search/chat-search.schema-verification';
import {BROWSER_AUTH_SESSION_SCHEMA_SQL} from '../browser-auth-sessions/browser-auth-session.schema';
import {PROJECT_RAG_AUTHORIZATION_SCHEMA_SQL} from '../models/project-rag-authorization.schema';
import {PROJECT_RAG_AUTHORIZATION_SCHEMA_ASSERT_SQL} from '../models/project-rag-authorization.schema-verification';
import {DEVICE_CODEX_SCHEMA_SQL} from '../models/device-codex.schema';
import {SYSTEM_ROLE_SCHEMA_SQL} from '../system-roles/system-role.schema';
import {SYSTEM_ROLE_CHAT_SCHEMA_SQL} from '../system-role-chat/system-role-chat.schema';
import {SYSTEM_ROLE_MCP_SCHEMA_SQL} from '../system-role-mcp/system-role-mcp.schema';
import {SYSTEM_ROLE_MCP_MAINTENANCE_SCHEMA_SQL} from '../system-role-mcp/system-role-mcp-maintenance.schema';
import {SYSTEM_ROLE_COORDINATOR_SCHEMA_SQL} from '../system-roles/system-role.coordinator.schema';
import {PROJECT_CHAT_DIALOGS_SCHEMA_SQL} from '../project-chat/project-chat-dialogs.schema';
import {PROJECT_CHAT_LEARNING_SCHEMA_SQL} from '../project-chat/project-chat-learning.schema';
import {PROJECT_CHAT_LEARNING_SCHEMA_ASSERT_SQL} from '../project-chat/project-chat-learning.schema-verification';
import {PROJECT_CHAT_ISOLATION_SCHEMA_SQL} from '../project-chat/project-chat-isolation.schema';
import {PROJECT_CHAT_ISOLATION_SCHEMA_ASSERT_SQL} from '../project-chat/project-chat-isolation.schema-verification';
import {CHAT_ACTIVITY_SCHEMA_SQL} from '../chat-activity/chat-activity.schema';
import {CHAT_ACTIVITY_SCHEMA_ASSERT_SQL} from '../chat-activity/chat-activity.schema-verification';
import {PROJECT_CHAT_DIALOGS_SCHEMA_ASSERT_SQL} from '../project-chat/project-chat-dialogs.schema-verification';
import {PROJECT_CHAT_SCHEMA_SQL} from '../project-chat/project-chat.schema';
import {PROJECT_CHAT_SCHEMA_ASSERT_SQL} from '../project-chat/project-chat.schema-verification';
import {MODEL_RATE_LIMITS_SCHEMA_SQL} from '../model-rate-limits/model-rate-limits.schema';
import {MODEL_RATE_LIMITS_SCHEMA_ASSERT_SQL} from '../model-rate-limits/model-rate-limits.schema-verification';
import {MODEL_USAGE_DETAILS_SCHEMA_SQL} from '../model-usage/model-usage-details.schema';
import {DISCUSSIONS_SCHEMA_SQL} from '../discussions/discussions.schema';
import {DISCUSSIONS_SCHEMA_ASSERT_SQL} from '../discussions/discussions.schema-verification';
import {CHAT_RESEARCH_SCHEMA_SQL} from '../model-chat/chat-research.schema';
import {CHAT_RESEARCH_SCHEMA_ASSERT_SQL} from '../model-chat/chat-research.schema-verification';
import {AGENT_SCHEMA_SQL} from '../agents/agent-schema';
import {BRIDGE_SOURCE_SCHEMA_SQL} from '../asset-sources/bridge-source.schema';
import {BRIDGE_SOURCE_SCHEMA_ASSERT_SQL} from '../asset-sources/bridge-source.schema-verification';
import {CATALOG_REQUEST_SCHEMA_SQL} from '../catalog-requests/request.schema';
import {CATALOG_REQUEST_SCHEMA_ASSERT_SQL} from '../catalog-requests/request.schema-verification';
import {AGENT_SCHEMA_ASSERT_SQL} from '../agents/agent-schema-verification';
import {LEARNING_SCHEMA_SQL} from '../learning/learning-schema';
import {LEARNING_SCHEMA_ASSERT_SQL} from '../learning/learning-schema-verification';
import {LEARNING_ANALYSIS_SCHEMA_SQL} from '../learning/learning-analysis-schema';
import {LEARNING_ANALYSIS_SCHEMA_ASSERT_SQL} from '../learning/learning-analysis-schema-verification';
import {INSTALLATION_MIGRATIONS} from '../devices/installation-migrations';
import type {CatalogMigration} from './migrations';
import {CATALOG_BASELINE_SQL} from './baseline-schema';
import {CATALOG_FINALIZE_SQL} from './finalize-schema';
import {CATALOG_SCHEMA_ASSERT_SQL} from './schema-verification';
import {SOURCE_ARCHIVE_SCHEMA_SQL} from '../asset-sources/source-archive.schema';
import {SOURCE_ARCHIVE_SCHEMA_ASSERT_SQL} from '../asset-sources/source-archive.schema-verification';
import {REMOTE_OPTIONS_SCHEMA_SQL} from '../models/remote-options.schema';
import {REMOTE_OPTIONS_SCHEMA_ASSERT_SQL} from '../models/remote-options.schema-verification';
import {CHAT_SCHEMA_SQL} from '../model-chat/chat.schema';
import {CHAT_SCHEMA_ASSERT_SQL} from '../model-chat/chat.schema-verification';
import {CHAT_COMPACTION_SCHEMA_SQL} from '../model-chat/chat-compaction.schema';
import {CHAT_COMPACTION_SCHEMA_ASSERT_SQL} from '../model-chat/chat-compaction.schema-verification';
import {CHAT_STORAGE_SCHEMA_SQL} from '../model-chat/chat-storage.schema';
import {CHAT_STORAGE_SCHEMA_ASSERT_SQL} from '../model-chat/chat-storage.schema-verification';
import {CHAT_GROUP_SCHEMA_SQL} from '../model-chat/chat-group.schema';
import {CHAT_GROUP_SCHEMA_ASSERT_SQL} from '../model-chat/chat-group.schema-verification';
import {CHAT_DISCUSSION_SCHEMA_SQL} from '../model-chat/chat-discussion.schema';
import {CHAT_DISCUSSION_SCHEMA_ASSERT_SQL} from '../model-chat/chat-discussion.schema-verification';
import {OPENCODE_MODEL_SYNC_SCHEMA_SQL} from '../models/opencode-model-sync.schema';
import {OPENCODE_MODEL_SYNC_SCHEMA_ASSERT_SQL} from '../models/opencode-model-sync.schema-verification';
import {MODEL_USAGE_SCHEMA_SQL} from '../model-usage/model-usage.schema';
import {MODEL_USAGE_SCHEMA_ASSERT_SQL} from '../model-usage/model-usage.schema-verification';
import {AGENT_READINESS_SCHEMA_SQL} from '../agent-readiness/agent-readiness.schema';
import {AGENT_READINESS_SCHEMA_ASSERT_SQL} from '../agent-readiness/agent-readiness.schema-verification';
import {PACKAGE_BUILD_CANCELLATION_SCHEMA_SQL} from '../package-build/package-build-cancellation.schema';
import {PACKAGE_BUILD_CANCELLATION_SCHEMA_ASSERT_SQL} from '../package-build/package-build-cancellation.schema-verification';
import {PACKAGE_AGENT_SCHEMA_SQL,PACKAGE_BUILD_RUNTIME_SCHEMA_SQL} from '../package-build/package-agent.schema';
import {PACKAGE_AGENT_SCHEMA_ASSERT_SQL} from '../package-build/package-agent.schema-verification';

/** Historical migrations 1–5 stay byte-identical; zero supplies their former startup prerequisites. */
export const CATALOG_MIGRATIONS:readonly CatalogMigration[]=[
    {version:0,name:'catalog-complete-baseline',sql:CATALOG_BASELINE_SQL},
    ...INSTALLATION_MIGRATIONS,
    {version:6,name:'catalog-schema-adoption',sql:CATALOG_FINALIZE_SQL+'\n'+CATALOG_SCHEMA_ASSERT_SQL},
    {version:7,name:'native-agents',sql:AGENT_SCHEMA_SQL+'\n'+AGENT_SCHEMA_ASSERT_SQL},
    {version:8,name:'catalog-requests',sql:CATALOG_REQUEST_SCHEMA_SQL+'\n'+CATALOG_REQUEST_SCHEMA_ASSERT_SQL},
    {version:9,name:'bridge-source-settings',sql:BRIDGE_SOURCE_SCHEMA_SQL+'\n'+BRIDGE_SOURCE_SCHEMA_ASSERT_SQL},
    {version:10,name:'project-learning-and-hypotheses',sql:LEARNING_SCHEMA_SQL+'\n'+LEARNING_ANALYSIS_SCHEMA_SQL+'\n'+LEARNING_SCHEMA_ASSERT_SQL+'\n'+LEARNING_ANALYSIS_SCHEMA_ASSERT_SQL},
    {version:11,name:'asset-source-archive-import',sql:SOURCE_ARCHIVE_SCHEMA_SQL+'\n'+SOURCE_ARCHIVE_SCHEMA_ASSERT_SQL},
    {version:12,name:'remote-model-connection-options',sql:REMOTE_OPTIONS_SCHEMA_SQL+'\n'+REMOTE_OPTIONS_SCHEMA_ASSERT_SQL},
    {version:13,name:'personal-model-chat-and-documents',sql:CHAT_SCHEMA_SQL+'\n'+CHAT_SCHEMA_ASSERT_SQL},
    {version:14,name:'persistent-model-chat-context',sql:CHAT_COMPACTION_SCHEMA_SQL+'\n'+CHAT_COMPACTION_SCHEMA_ASSERT_SQL},
    {version:15,name:'model-chat-ceph-attachments',sql:CHAT_STORAGE_SCHEMA_SQL+'\n'+CHAT_STORAGE_SCHEMA_ASSERT_SQL},
    {version:16,name:'project-agent-chat-rounds',sql:CHAT_GROUP_SCHEMA_SQL+'\n'+CHAT_GROUP_SCHEMA_ASSERT_SQL},
    {version:17,name:'opencode-model-auto-sync',sql:OPENCODE_MODEL_SYNC_SCHEMA_SQL+'\n'+OPENCODE_MODEL_SYNC_SCHEMA_ASSERT_SQL},
    {version:18,name:'model-inference-usage-ledger',sql:MODEL_USAGE_SCHEMA_SQL+'\n'+MODEL_USAGE_SCHEMA_ASSERT_SQL},
    {version:19,name:'bounded-chat-research',sql:CHAT_RESEARCH_SCHEMA_SQL+'\n'+CHAT_RESEARCH_SCHEMA_ASSERT_SQL},
    {version:20,name:'project-agent-diagnostic-trials',sql:AGENT_READINESS_SCHEMA_SQL+'\n'+AGENT_READINESS_SCHEMA_ASSERT_SQL},
    {version:21,name:'durable-tool-build-cancellation',sql:PACKAGE_BUILD_CANCELLATION_SCHEMA_SQL+'\n'+PACKAGE_BUILD_CANCELLATION_SCHEMA_ASSERT_SQL},
    {version:22,name:'help-and-catalog-discussions',sql:DISCUSSIONS_SCHEMA_SQL+'\n'+DISCUSSIONS_SCHEMA_ASSERT_SQL},
    {version:23,name:'shared-project-team-chat',sql:PROJECT_CHAT_SCHEMA_SQL+'\n'+PROJECT_CHAT_SCHEMA_ASSERT_SQL},
    {version:24,name:'per-model-api-rate-limits-and-usage-detail',sql:MODEL_RATE_LIMITS_SCHEMA_SQL+'\n'+MODEL_USAGE_DETAILS_SCHEMA_SQL+'\n'+MODEL_RATE_LIMITS_SCHEMA_ASSERT_SQL},
    {version:25,name:'public-and-private-project-dialogues',sql:PROJECT_CHAT_DIALOGS_SCHEMA_SQL+'\n'+PROJECT_CHAT_DIALOGS_SCHEMA_ASSERT_SQL},
    {version:26,name:'chat-presence-typing-and-visible-message-receipts',sql:CHAT_ACTIVITY_SCHEMA_SQL+'\n'+CHAT_ACTIVITY_SCHEMA_ASSERT_SQL},
    {version:27,name:'packager-agent-and-runtime-verification',sql:PACKAGE_AGENT_SCHEMA_SQL+'\n'+PACKAGE_BUILD_RUNTIME_SCHEMA_SQL+'\n'+PACKAGE_AGENT_SCHEMA_ASSERT_SQL},
    {version:28,name:'bounded-system-role-agents',sql:SYSTEM_ROLE_SCHEMA_SQL},
    {version:29,name:'private-device-codex-inference',sql:DEVICE_CODEX_SCHEMA_SQL},
    {version:30,name:'fresh-project-rag-write-authorization',sql:PROJECT_RAG_AUTHORIZATION_SCHEMA_SQL+'\n'+PROJECT_RAG_AUTHORIZATION_SCHEMA_ASSERT_SQL},
    {version:31,name:'project-team-chat-learning-receipts',sql:PROJECT_CHAT_LEARNING_SCHEMA_SQL+'\n'+PROJECT_CHAT_LEARNING_SCHEMA_ASSERT_SQL},
    {version:32,name:'isolated-project-chat-room-execution',sql:PROJECT_CHAT_ISOLATION_SCHEMA_SQL+'\n'+PROJECT_CHAT_ISOLATION_SCHEMA_ASSERT_SQL},
    {version:33,name:'bounded-system-role-coordinator',sql:SYSTEM_ROLE_COORDINATOR_SCHEMA_SQL},
    {version:34,name:'bounded-private-group-discussions',sql:CHAT_DISCUSSION_SCHEMA_SQL+'\n'+CHAT_DISCUSSION_SCHEMA_ASSERT_SQL},
    {version:35,name:'private-system-role-service-chat',sql:SYSTEM_ROLE_CHAT_SCHEMA_SQL},
    {version:36,name:'bounded-system-role-mcp-execution',sql:SYSTEM_ROLE_MCP_SCHEMA_SQL},
    {version:37,name:'durable-device-mcp-cleanup',sql:SYSTEM_ROLE_MCP_MAINTENANCE_SCHEMA_SQL},
    {version:38,name:'durable-opaque-browser-sessions',sql:BROWSER_AUTH_SESSION_SCHEMA_SQL},
    {version:39,name:'public-chat-semantic-search',sql:CHAT_SEARCH_SCHEMA_SQL+'\n'+CHAT_SEARCH_SCHEMA_ASSERT_SQL},
    {version:40,name:'private-system-role-chat-origins',sql:CHAT_SYSTEM_ROLE_SCHEMA_SQL+'\n'+CHAT_SYSTEM_ROLE_SCHEMA_ASSERT_SQL},
    {version:41,name:'approved-plugin-auto-updates',sql:PLUGIN_AUTO_UPDATE_SCHEMA_SQL+'\n'+PLUGIN_AUTO_UPDATE_SCHEMA_ASSERT_SQL},
    {version:42,name:'bounded-project-agent-tools',sql:AGENT_TOOLS_SCHEMA_SQL+'\n'+AGENT_TOOLS_SCHEMA_ASSERT_SQL},
    {version:43,name:'role-specific-service-conversations',sql:SERVICE_ROLE_CONVERSATIONS_SCHEMA_SQL+'\n'+SERVICE_ROLE_CONVERSATIONS_SCHEMA_ASSERT_SQL},
    {version:44,name:'conditional-agent-response-summaries',sql:CHAT_SUMMARY_POLICY_SCHEMA_SQL+'\n'+CHAT_SUMMARY_POLICY_SCHEMA_ASSERT_SQL},
];
