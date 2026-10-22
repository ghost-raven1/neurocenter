/** Migration 21 facts; the released active-owner index stays unchanged. */
export const PACKAGE_BUILD_CANCELLATION_SCHEMA_CONTRACT=[
    {kind:'column',id:'tool_build_jobs.publication_started_at',definition:{type:'timestamp with time zone',default:null,notNull:false}},
    {kind:'column',id:'tool_build_jobs.execution_nonce',definition:{type:'uuid',default:null,notNull:false}},
    {kind:'column',id:'tool_build_jobs.execution_host',definition:{type:'text',default:null,notNull:false}},
    {kind:'column',id:'tool_build_jobs.execution_pid',definition:{type:'integer',default:null,notNull:false}},
    {kind:'column',id:'tool_build_jobs.execution_started',definition:{type:'boolean',default:'false',notNull:true}},
    {kind:'constraint',id:'tool_build_jobs.tool_build_jobs_state_check',definition:{type:'c',validated:true,definition:"CHECK (state = ANY (ARRAY['QUEUED'::text, 'RUNNING'::text, 'CANCELLING'::text, 'CANCELLED'::text, 'SUCCEEDED'::text, 'FAILED'::text]))"}},
    {kind:'table',id:'tool_build_cancellations',definition:{kind:'r',persistence:'p'}},
    {kind:'column',id:'tool_build_cancellations.actor',definition:{type:'text',default:null,notNull:true}},
    {kind:'column',id:'tool_build_cancellations.request_key',definition:{type:'uuid',default:null,notNull:true}},
    {kind:'column',id:'tool_build_cancellations.created_at',definition:{type:'timestamp with time zone',default:'now()',notNull:true}},
    {kind:'constraint',id:'tool_build_cancellations.tool_build_cancellations_pkey',definition:{type:'p',validated:true,definition:'PRIMARY KEY (actor, request_key)'}},
    {kind:'index',id:'tool_build_cancellations_pkey',definition:{ready:true,valid:true,definition:'CREATE UNIQUE INDEX tool_build_cancellations_pkey ON tool_build_cancellations USING btree (actor, request_key)'}},
];
