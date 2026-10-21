/** Audit metadata only: no prompts, replies, credentials, URLs or provider error bodies. */
export const MODEL_USAGE_SCHEMA_SQL = `
CREATE TABLE model_usage_calls (
 id uuid PRIMARY KEY,worker_id uuid NOT NULL,model_id text NOT NULL,model_name text NOT NULL,provider text NOT NULL,
 endpoint text NOT NULL CHECK(endpoint IN ('chat','embed')),
 purpose text NOT NULL CHECK(purpose IN ('chat','agent','compaction','project-search','device-embedding','reindex','learning','direct','verification')),
 actor_email text,project_id text,agent_id text,turn_id uuid,operation_id uuid,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','success','error','cancelled','interrupted')),
 input_tokens bigint CHECK(input_tokens>=0),output_tokens bigint CHECK(output_tokens>=0),
 latency_ms integer CHECK(latency_ms>=0),started_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz,
 lease_until timestamptz, CHECK((status='pending' AND finished_at IS NULL AND lease_until IS NOT NULL) OR(status<>'pending' AND finished_at IS NOT NULL AND lease_until IS NULL))
);
CREATE INDEX model_usage_calls_time ON model_usage_calls(started_at DESC,id DESC);
CREATE INDEX model_usage_calls_project ON model_usage_calls(project_id,started_at DESC,id DESC);
CREATE INDEX model_usage_calls_actor ON model_usage_calls(actor_email,started_at DESC,id DESC);
CREATE INDEX model_usage_calls_pending ON model_usage_calls(worker_id,lease_until) WHERE status='pending';
`;
