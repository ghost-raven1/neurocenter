import { HOSTED_RAG_REVOCATION_SQL } from '../devices/hosted-rag-grant-sql';
import { RETIREMENT_REFERENCE_SCHEMA_SQL } from '../retired-rag/retirement-reference-schema';
import { REINDEX_OPERATION_SCHEMA_SQL } from '../operations/operation-schema';

/** These triggers require the historical bridge/snapshot tables, so they follow migration 5. */
export const CATALOG_FINALIZE_SQL = [
    // Released before 3222606: CREATE IF NOT EXISTS left this default unchanged on upgrade.
    `DO $bridge_message_default$ BEGIN
        IF (SELECT pg_get_expr(d.adbin,d.adrelid) FROM pg_attrdef d
            JOIN pg_attribute a ON a.attrelid=d.adrelid AND a.attnum=d.adnum
            JOIN pg_class c ON c.oid=a.attrelid
            WHERE c.relnamespace=to_regnamespace(current_schema()) AND c.relname='bridge_jobs' AND a.attname='message')
            =quote_literal('Ожидает MCP')||'::text' THEN
            ALTER TABLE bridge_jobs ALTER COLUMN message SET DEFAULT 'Ожидает моста';
        END IF;
    END $bridge_message_default$;`,
    HOSTED_RAG_REVOCATION_SQL,
    RETIREMENT_REFERENCE_SCHEMA_SQL,
    REINDEX_OPERATION_SCHEMA_SQL,
    `DO $native_history$ BEGIN
        IF to_regclass('builtin_catalog_receipts') IS NOT NULL THEN
            INSERT INTO asset_native_migrations(migration,old_key,native_id,provenance,evidence)
                SELECT 'catalog-source-v1',tool_key,asset_id,'local-unattributed',to_jsonb(receipt)
                FROM builtin_catalog_receipts receipt ON CONFLICT DO NOTHING;
            DROP TABLE builtin_catalog_receipts;
        END IF;
    END $native_history$;`,
].join(';\n');
