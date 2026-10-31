/** Archive origin and offline intent survive process restarts and refreshes. */
export const SOURCE_ARCHIVE_SCHEMA_SQL = `
ALTER TABLE asset_source_snapshots ADD COLUMN archive_sha256 text CHECK(archive_sha256 ~ '^[a-f0-9]{64}$');
ALTER TABLE asset_source_jobs ADD COLUMN cache_only boolean NOT NULL DEFAULT false;
`;
