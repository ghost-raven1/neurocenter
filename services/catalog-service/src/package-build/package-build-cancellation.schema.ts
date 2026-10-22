/** Migration 21 adds durable cancellation without changing the released baseline. */
export const PACKAGE_BUILD_CANCELLATION_SCHEMA_SQL=`
ALTER TABLE tool_build_jobs ADD COLUMN publication_started_at timestamptz;
ALTER TABLE tool_build_jobs ADD COLUMN execution_nonce uuid,ADD COLUMN execution_host text,ADD COLUMN execution_pid integer,ADD COLUMN execution_started boolean NOT NULL DEFAULT false;
ALTER TABLE tool_build_jobs DROP CONSTRAINT tool_build_jobs_state_check;
ALTER TABLE tool_build_jobs ADD CONSTRAINT tool_build_jobs_state_check CHECK(state IN ('QUEUED','RUNNING','CANCELLING','CANCELLED','SUCCEEDED','FAILED'));
CREATE TABLE tool_build_cancellations (
 actor text NOT NULL,request_key uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(actor,request_key)
);
`;
