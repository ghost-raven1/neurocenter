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
];
