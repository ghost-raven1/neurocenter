/** Migration 52 replaces the single RUNNING row with a bounded set of run slots. */
export const PACKAGE_BUILD_SLOTS_SCHEMA_SQL = `
ALTER TABLE tool_build_jobs ADD COLUMN run_slot integer;
DROP INDEX IF EXISTS tool_build_one_running;
CREATE UNIQUE INDEX tool_build_run_slot_running ON tool_build_jobs USING btree (run_slot) WHERE state='RUNNING' AND run_slot IS NOT NULL;
`;
