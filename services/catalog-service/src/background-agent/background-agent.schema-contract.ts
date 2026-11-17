/** Migration62 physical facts measured on owned PostgreSQL16. */
export const BACKGROUND_AGENT_SCHEMA_CONTRACT = [
  {
    "kind": "column",
    "id": "background_agent_effects.created_at",
    "definition": {
      "type": "timestamp with time zone",
      "default": "now()",
      "notNull": true
    }
  },
  {
    "kind": "column",
    "id": "background_agent_effects.phase",
    "definition": {
      "type": "text",
      "default": null,
      "notNull": true
    }
  },
  {
    "kind": "column",
    "id": "background_agent_effects.request_key",
    "definition": {
      "type": "text",
      "default": null,
      "notNull": true
    }
  },
  {
    "kind": "column",
    "id": "background_agent_jobs.attempts",
    "definition": {
      "type": "integer",
      "default": "0",
      "notNull": true
    }
  },
  {
    "kind": "column",
    "id": "background_agent_jobs.completed_at",
    "definition": {
      "type": "timestamp with time zone",
      "default": null,
      "notNull": false
    }
  },
  {
    "kind": "column",
    "id": "background_agent_jobs.created_at",
    "definition": {
      "type": "timestamp with time zone",
      "default": "now()",
      "notNull": true
    }
  },
  {
    "kind": "column",
    "id": "background_agent_jobs.dead_letter_reason",
    "definition": {
      "type": "text",
      "default": null,
      "notNull": false
    }
  },
  {
    "kind": "column",
    "id": "background_agent_jobs.delivered",
    "definition": {
      "type": "boolean",
      "default": "false",
      "notNull": true
    }
  },
  {
    "kind": "column",
    "id": "background_agent_jobs.email",
    "definition": {
      "type": "text",
      "default": null,
      "notNull": true
    }
  },
  {
    "kind": "column",
    "id": "background_agent_jobs.heartbeat_at",
    "definition": {
      "type": "timestamp with time zone",
      "default": null,
      "notNull": false
    }
  },
  {
    "kind": "column",
    "id": "background_agent_jobs.kind",
    "definition": {
      "type": "text",
      "default": "'run-background-agent-workflow'::text",
      "notNull": true
    }
  },
  {
    "kind": "column",
    "id": "background_agent_jobs.lease_token",
    "definition": {
      "type": "uuid",
      "default": null,
      "notNull": false
    }
  },
  {
    "kind": "column",
    "id": "background_agent_jobs.lease_until",
    "definition": {
      "type": "timestamp with time zone",
      "default": null,
      "notNull": false
    }
  },
  {
    "kind": "column",
    "id": "background_agent_jobs.next_attempt_at",
    "definition": {
      "type": "timestamp with time zone",
      "default": null,
      "notNull": false
    }
  },
  {
    "kind": "column",
    "id": "background_agent_jobs.payload",
    "definition": {
      "type": "jsonb",
      "default": null,
      "notNull": true
    }
  },
  {
    "kind": "column",
    "id": "background_agent_jobs.project_id",
    "definition": {
      "type": "text",
      "default": null,
      "notNull": true
    }
  },
  {
    "kind": "column",
    "id": "background_agent_jobs.publish_state",
    "definition": {
      "type": "text",
      "default": "'pending'::text",
      "notNull": true
    }
  },
  {
    "kind": "column",
    "id": "background_agent_jobs.request_id",
    "definition": {
      "type": "uuid",
      "default": null,
      "notNull": true
    }
  },
  {
    "kind": "column",
    "id": "background_agent_jobs.request_key",
    "definition": {
      "type": "text",
      "default": null,
      "notNull": true
    }
  },
  {
    "kind": "column",
    "id": "background_agent_jobs.result",
    "definition": {
      "type": "jsonb",
      "default": null,
      "notNull": false
    }
  },
  {
    "kind": "column",
    "id": "background_agent_jobs.role",
    "definition": {
      "type": "text",
      "default": null,
      "notNull": true
    }
  },
  {
    "kind": "column",
    "id": "background_agent_jobs.runtime_version",
    "definition": {
      "type": "text",
      "default": null,
      "notNull": true
    }
  },
  {
    "kind": "column",
    "id": "background_agent_jobs.source_message_id",
    "definition": {
      "type": "uuid",
      "default": null,
      "notNull": false
    }
  },
  {
    "kind": "column",
    "id": "background_agent_jobs.state",
    "definition": {
      "type": "text",
      "default": "'pending'::text",
      "notNull": true
    }
  },
  {
    "kind": "column",
    "id": "background_agent_jobs.unknown",
    "definition": {
      "type": "boolean",
      "default": "false",
      "notNull": true
    }
  },
  {
    "kind": "column",
    "id": "background_agent_jobs.updated_at",
    "definition": {
      "type": "timestamp with time zone",
      "default": "now()",
      "notNull": true
    }
  },
  {
    "kind": "constraint",
    "id": "background_agent_effects.background_agent_effects_phase_check",
    "definition": {
      "type": "c",
      "validated": true,
      "definition": "CHECK (phase = ANY (ARRAY['execution'::text, 'result'::text, 'publish'::text]))"
    }
  },
  {
    "kind": "constraint",
    "id": "background_agent_effects.background_agent_effects_pkey",
    "definition": {
      "type": "p",
      "validated": true,
      "definition": "PRIMARY KEY (request_key, phase)"
    }
  },
  {
    "kind": "constraint",
    "id": "background_agent_effects.background_agent_effects_request_key_fkey",
    "definition": {
      "type": "f",
      "validated": true,
      "definition": "FOREIGN KEY (request_key) REFERENCES background_agent_jobs(request_key) ON DELETE CASCADE"
    }
  },
  {
    "kind": "constraint",
    "id": "background_agent_jobs.background_agent_jobs_attempts_check",
    "definition": {
      "type": "c",
      "validated": true,
      "definition": "CHECK (attempts >= 0)"
    }
  },
  {
    "kind": "constraint",
    "id": "background_agent_jobs.background_agent_jobs_check",
    "definition": {
      "type": "c",
      "validated": true,
      "definition": "CHECK ((state = 'running'::text) = (lease_until IS NOT NULL))"
    }
  },
  {
    "kind": "constraint",
    "id": "background_agent_jobs.background_agent_jobs_payload_check",
    "definition": {
      "type": "c",
      "validated": true,
      "definition": "CHECK (jsonb_typeof(payload) = 'object'::text)"
    }
  },
  {
    "kind": "constraint",
    "id": "background_agent_jobs.background_agent_jobs_pkey",
    "definition": {
      "type": "p",
      "validated": true,
      "definition": "PRIMARY KEY (request_key)"
    }
  },
  {
    "kind": "constraint",
    "id": "background_agent_jobs.background_agent_jobs_project_id_fkey",
    "definition": {
      "type": "f",
      "validated": true,
      "definition": "FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE"
    }
  },
  {
    "kind": "constraint",
    "id": "background_agent_jobs.background_agent_jobs_project_id_source_message_id_fkey",
    "definition": {
      "type": "f",
      "validated": true,
      "definition": "FOREIGN KEY (project_id, source_message_id) REFERENCES project_chat_messages(project_id, id) ON DELETE SET NULL"
    }
  },
  {
    "kind": "constraint",
    "id": "background_agent_jobs.background_agent_jobs_publish_state_check",
    "definition": {
      "type": "c",
      "validated": true,
      "definition": "CHECK (publish_state = ANY (ARRAY['pending'::text, 'published'::text, 'withheld'::text]))"
    }
  },
  {
    "kind": "constraint",
    "id": "background_agent_jobs.background_agent_jobs_request_id_key",
    "definition": {
      "type": "u",
      "validated": true,
      "definition": "UNIQUE (request_id)"
    }
  },
  {
    "kind": "constraint",
    "id": "background_agent_jobs.background_agent_jobs_request_key_check",
    "definition": {
      "type": "c",
      "validated": true,
      "definition": "CHECK (request_key ~ '^[a-f0-9]{64}$'::text)"
    }
  },
  {
    "kind": "constraint",
    "id": "background_agent_jobs.background_agent_jobs_state_check",
    "definition": {
      "type": "c",
      "validated": true,
      "definition": "CHECK (state = ANY (ARRAY['pending'::text, 'running'::text, 'succeeded'::text, 'failed'::text, 'dead_letter'::text]))"
    }
  },
  {
    "kind": "index",
    "id": "background_agent_effects_pkey",
    "definition": {
      "ready": true,
      "valid": true,
      "definition": "CREATE UNIQUE INDEX background_agent_effects_pkey ON background_agent_effects USING btree (request_key, phase)"
    }
  },
  {
    "kind": "index",
    "id": "background_agent_jobs_claim_idx",
    "definition": {
      "ready": true,
      "valid": true,
      "definition": "CREATE INDEX background_agent_jobs_claim_idx ON background_agent_jobs USING btree (created_at) WHERE (state = 'pending'::text)"
    }
  },
  {
    "kind": "index",
    "id": "background_agent_jobs_pkey",
    "definition": {
      "ready": true,
      "valid": true,
      "definition": "CREATE UNIQUE INDEX background_agent_jobs_pkey ON background_agent_jobs USING btree (request_key)"
    }
  },
  {
    "kind": "index",
    "id": "background_agent_jobs_project_idx",
    "definition": {
      "ready": true,
      "valid": true,
      "definition": "CREATE INDEX background_agent_jobs_project_idx ON background_agent_jobs USING btree (project_id)"
    }
  },
  {
    "kind": "index",
    "id": "background_agent_jobs_request_id_key",
    "definition": {
      "ready": true,
      "valid": true,
      "definition": "CREATE UNIQUE INDEX background_agent_jobs_request_id_key ON background_agent_jobs USING btree (request_id)"
    }
  },
  {
    "kind": "table",
    "id": "background_agent_effects",
    "definition": {
      "kind": "r",
      "persistence": "p"
    }
  },
  {
    "kind": "table",
    "id": "background_agent_jobs",
    "definition": {
      "kind": "r",
      "persistence": "p"
    }
  }
];
