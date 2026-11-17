/**
 * FR-305 (agt-07, phase B): the server background-agent job store (migration 62).
 *
 * Own space, not bridge_jobs (block 3 scope): one row per admitted task, keyed by the receipt
 * idempotency digest (request_key = backgroundAgentDigest of the normalized immutable payload).
 * The run state, lease/heartbeat (OQ-1: one executor, but the code must not break at scale),
 * crash-policy counters and the verified result live here; the effect checkpoints
 * (request_key/phase, epic-8 entry 12) are journaled in background_agent_effects.
 *
 * Version-neutral additive SQL; ROOT owns contiguous migration registration and reset classification.
 */
export const BACKGROUND_AGENT_SCHEMA_SQL = `
CREATE TABLE background_agent_jobs (
 request_key text PRIMARY KEY CHECK(request_key ~ '^[a-f0-9]{64}$'),
 request_id uuid NOT NULL,
 kind text NOT NULL DEFAULT 'run-background-agent-workflow',
 project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 email text NOT NULL,
 role text NOT NULL,
 payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
 source_message_id uuid,
 runtime_version text NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','succeeded','failed','dead_letter')),
 result jsonb,
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
 next_attempt_at timestamptz,
 unknown boolean NOT NULL DEFAULT false,
 dead_letter_reason text,
 lease_token uuid,
 lease_until timestamptz,
 heartbeat_at timestamptz,
 delivered boolean NOT NULL DEFAULT false,
 publish_state text NOT NULL DEFAULT 'pending' CHECK(publish_state IN ('pending','published','withheld')),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 completed_at timestamptz,
 UNIQUE(request_id),
 CHECK((state='running')=(lease_until IS NOT NULL)),
 FOREIGN KEY(project_id,source_message_id) REFERENCES project_chat_messages(project_id,id) ON DELETE SET NULL
);
CREATE INDEX background_agent_jobs_claim_idx ON background_agent_jobs (created_at) WHERE state='pending';
CREATE INDEX background_agent_jobs_project_idx ON background_agent_jobs (project_id);
CREATE TABLE background_agent_effects (
 request_key text NOT NULL REFERENCES background_agent_jobs(request_key) ON DELETE CASCADE,
 phase text NOT NULL CHECK(phase IN ('execution','result','publish')),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(request_key,phase)
);
`;
