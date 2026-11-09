/**
 * Entry 5.11 (AD-D3): per-domain receipt for a confirmed project deletion.
 *
 * `deleted_resources` is an additive JSONB column on the frozen `project_retirements`
 * table. It records, per storage domain (rag, chat, snapshots, skills, dumps), whether the
 * project's physical resources were deleted, were absent, are still pending, or failed.
 * The column is version-neutral additive SQL; ROOT owns contiguous migration registration
 * and reset classification.
 */
export const PROJECT_DELETION_RECEIPT_SCHEMA_SQL = `
ALTER TABLE project_retirements ADD COLUMN IF NOT EXISTS deleted_resources JSONB NOT NULL DEFAULT '{}'::jsonb;
`;
