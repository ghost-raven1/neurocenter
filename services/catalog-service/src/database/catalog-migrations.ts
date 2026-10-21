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
];
