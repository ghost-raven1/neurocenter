/** Frozen structural facts for migration 11. */
export const SOURCE_ARCHIVE_SCHEMA_CONTRACT=[
 {kind:'column',id:'asset_source_snapshots.archive_sha256',definition:{type:'text',default:null,notNull:false}},
 {kind:'column',id:'asset_source_jobs.cache_only',definition:{type:'boolean',default:'false',notNull:true}},
 {kind:'constraint',id:'asset_source_snapshots.asset_source_snapshots_archive_sha256_check',definition:{type:'c',validated:true,definition:"CHECK (archive_sha256 ~ '^[a-f0-9]{64}$'::text)"}},
];
