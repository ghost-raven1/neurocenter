import {AGENT_SCHEMA_SQL} from '../agents/agent-schema';
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

/** Historical migrations 1–5 stay byte-identical; zero supplies their former startup prerequisites. */
export const CATALOG_MIGRATIONS:readonly CatalogMigration[]=[
    {version:0,name:'catalog-complete-baseline',sql:CATALOG_BASELINE_SQL},
    ...INSTALLATION_MIGRATIONS,
    {version:6,name:'catalog-schema-adoption',sql:CATALOG_FINALIZE_SQL+'\n'+CATALOG_SCHEMA_ASSERT_SQL},
    {version:7,name:'native-agents',sql:AGENT_SCHEMA_SQL+'\n'+AGENT_SCHEMA_ASSERT_SQL},
    {version:8,name:'project-learning-and-hypotheses',sql:LEARNING_SCHEMA_SQL+'\n'+LEARNING_ANALYSIS_SCHEMA_SQL+'\n'+LEARNING_SCHEMA_ASSERT_SQL+'\n'+LEARNING_ANALYSIS_SCHEMA_ASSERT_SQL},
];
