/** Migration 52 facts; the released single-running index is replaced by the slot index. */
export const PACKAGE_BUILD_SLOTS_SCHEMA_CONTRACT = [
    {
        kind: 'column',
        id: 'tool_build_jobs.run_slot',
        definition: { type: 'integer', default: null, notNull: false },
    },
    {
        kind: 'index',
        id: 'tool_build_run_slot_running',
        definition: {
            ready: true,
            valid: true,
            definition:
                "CREATE UNIQUE INDEX tool_build_run_slot_running ON tool_build_jobs USING btree (run_slot) WHERE ((state = 'RUNNING'::text) AND (run_slot IS NOT NULL))",
        },
    },
];
