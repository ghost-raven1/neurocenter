import {PROJECT_CHAT_SCHEMA_SQL} from '../project-chat/project-chat.schema';
import {PROJECT_CHAT_SCHEMA_ASSERT_SQL} from '../project-chat/project-chat.schema-verification';
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
import {OPENCODE_MODEL_SYNC_SCHEMA_SQL} from '../models/opencode-model-sync.schema';
import {OPENCODE_MODEL_SYNC_SCHEMA_ASSERT_SQL} from '../models/opencode-model-sync.schema-verification';
import {MODEL_USAGE_SCHEMA_SQL} from '../model-usage/model-usage.schema';
import {MODEL_USAGE_SCHEMA_ASSERT_SQL} from '../model-usage/model-usage.schema-verification';
import {AGENT_READINESS_SCHEMA_SQL} from '../agent-readiness/agent-readiness.schema';
import {AGENT_READINESS_SCHEMA_ASSERT_SQL} from '../agent-readiness/agent-readiness.schema-verification';
import {PACKAGE_BUILD_CANCELLATION_SCHEMA_SQL} from '../package-build/package-build-cancellation.schema';
import {PACKAGE_BUILD_CANCELLATION_SCHEMA_ASSERT_SQL} from '../package-build/package-build-cancellation.schema-verification';

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
];
