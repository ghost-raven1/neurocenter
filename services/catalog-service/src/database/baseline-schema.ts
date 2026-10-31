import { ACCESS_SCHEMA_SQL } from '../access/access-schema';
import { CATALOG_SCHEMA_SQL } from '../catalog/catalog-schema';
import { PUBLICATION_SCHEMA_SQL } from '../publication/publication-schema';
import { MODEL_SCHEMA_SQL } from '../models/model-schema';
import { DEVICE_SCHEMA_SQL } from '../devices/device-schema';
import { HOSTED_RAG_GRANT_SCHEMA_SQL } from '../devices/hosted-rag-grant-sql';
import { RETIREMENT_SCHEMA_SQL } from '../retired-rag/retirement-schema-sql';
import { ASSET_SOURCE_SCHEMA_SQL } from '../asset-sources/asset-source-schema';
import { MODEL_JOB_SCHEMA_SQL } from '../models/model-job-schema';
import { MAINTENANCE_SCHEMA_SQL } from '../maintenance/maintenance-schema';
import { SOURCE_UPLOAD_SCHEMA_SQL } from '../source-upload/source-upload-schema';
import { RESTORE_SCHEMA_SQL } from '../restore/restore-schema';
import { PACKAGE_BUILD_SCHEMA_SQL } from '../package-build/package-build-schema';

/** Prerequisites precede the unchanged historical migrations; no feature starts its own DDL. */
export const CATALOG_BASELINE_SQL = [
    ACCESS_SCHEMA_SQL,
    CATALOG_SCHEMA_SQL,
    PUBLICATION_SCHEMA_SQL,
    MODEL_SCHEMA_SQL,
    DEVICE_SCHEMA_SQL,
    HOSTED_RAG_GRANT_SCHEMA_SQL,
    RETIREMENT_SCHEMA_SQL,
    ASSET_SOURCE_SCHEMA_SQL,
    `CREATE TABLE IF NOT EXISTS asset_native_migrations (
        migration text NOT NULL,old_key text NOT NULL,native_id text NOT NULL,
        provenance text NOT NULL CHECK(provenance='local-unattributed'),evidence jsonb NOT NULL,
        migrated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(migration,old_key));`,
    MODEL_JOB_SCHEMA_SQL,
    MAINTENANCE_SCHEMA_SQL,
    SOURCE_UPLOAD_SCHEMA_SQL,
    RESTORE_SCHEMA_SQL,
    PACKAGE_BUILD_SCHEMA_SQL,
].join(';\n');
