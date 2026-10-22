/** Migration 20 physical facts, measured on isolated PostgreSQL 16. */
export const AGENT_READINESS_SCHEMA_CONTRACT = [
    {
        "kind": "column",
        "id": "agent_readiness_trials.agent_id",
        "definition": {
            "type": "text",
            "default": null,
            "notNull": true
        }
    },
    {
        "kind": "column",
        "id": "agent_readiness_trials.created_at",
        "definition": {
            "type": "timestamp with time zone",
            "default": "now()",
            "notNull": true
        }
    },
    {
        "kind": "column",
        "id": "agent_readiness_trials.finished_at",
        "definition": {
            "type": "timestamp with time zone",
            "default": null,
            "notNull": false
        }
    },
    {
        "kind": "column",
        "id": "agent_readiness_trials.id",
        "definition": {
            "type": "uuid",
            "default": null,
            "notNull": true
        }
    },
    {
        "kind": "column",
        "id": "agent_readiness_trials.lease_token",
        "definition": {
            "type": "uuid",
            "default": null,
            "notNull": true
        }
    },
    {
        "kind": "column",
        "id": "agent_readiness_trials.lease_until",
        "definition": {
            "type": "timestamp with time zone",
            "default": null,
            "notNull": false
        }
    },
    {
        "kind": "column",
        "id": "agent_readiness_trials.message",
        "definition": {
            "type": "text",
            "default": null,
            "notNull": true
        }
    },
    {
        "kind": "column",
        "id": "agent_readiness_trials.owner_email",
        "definition": {
            "type": "text",
            "default": null,
            "notNull": true
        }
    },
    {
        "kind": "column",
        "id": "agent_readiness_trials.project_id",
        "definition": {
            "type": "text",
            "default": null,
            "notNull": true
        }
    },
    {
        "kind": "column",
        "id": "agent_readiness_trials.receipt",
        "definition": {
            "type": "jsonb",
            "default": null,
            "notNull": true
        }
    },
    {
        "kind": "column",
        "id": "agent_readiness_trials.request",
        "definition": {
            "type": "jsonb",
            "default": null,
            "notNull": true
        }
    },
    {
        "kind": "column",
        "id": "agent_readiness_trials.request_hash",
        "definition": {
            "type": "text",
            "default": null,
            "notNull": true
        }
    },
    {
        "kind": "column",
        "id": "agent_readiness_trials.request_id",
        "definition": {
            "type": "uuid",
            "default": null,
            "notNull": true
        }
    },
    {
        "kind": "column",
        "id": "agent_readiness_trials.revision",
        "definition": {
            "type": "integer",
            "default": "0",
            "notNull": true
        }
    },
    {
        "kind": "column",
        "id": "agent_readiness_trials.snapshot",
        "definition": {
            "type": "jsonb",
            "default": null,
            "notNull": true
        }
    },
    {
        "kind": "column",
        "id": "agent_readiness_trials.status",
        "definition": {
            "type": "text",
            "default": "'queued'::text",
            "notNull": true
        }
    },
    {
        "kind": "constraint",
        "id": "agent_readiness_trials.agent_readiness_trials_agent_id_fkey",
        "definition": {
            "type": "f",
            "validated": true,
            "definition": "FOREIGN KEY (agent_id) REFERENCES agent_catalog(id)"
        }
    },
    {
        "kind": "constraint",
        "id": "agent_readiness_trials.agent_readiness_trials_check",
        "definition": {
            "type": "c",
            "validated": true,
            "definition": "CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text])) AND finished_at IS NULL AND lease_until IS NOT NULL OR (status <> ALL (ARRAY['queued'::text, 'running'::text])) AND finished_at IS NOT NULL AND lease_until IS NULL)"
        }
    },
    {
        "kind": "constraint",
        "id": "agent_readiness_trials.agent_readiness_trials_message_check",
        "definition": {
            "type": "c",
            "validated": true,
            "definition": "CHECK (octet_length(message) <= 2048)"
        }
    },
    {
        "kind": "constraint",
        "id": "agent_readiness_trials.agent_readiness_trials_owner_email_request_id_key",
        "definition": {
            "type": "u",
            "validated": true,
            "definition": "UNIQUE (owner_email, request_id)"
        }
    },
    {
        "kind": "constraint",
        "id": "agent_readiness_trials.agent_readiness_trials_pkey",
        "definition": {
            "type": "p",
            "validated": true,
            "definition": "PRIMARY KEY (id)"
        }
    },
    {
        "kind": "constraint",
        "id": "agent_readiness_trials.agent_readiness_trials_project_id_fkey",
        "definition": {
            "type": "f",
            "validated": true,
            "definition": "FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE"
        }
    },
    {
        "kind": "constraint",
        "id": "agent_readiness_trials.agent_readiness_trials_receipt_check",
        "definition": {
            "type": "c",
            "validated": true,
            "definition": "CHECK (jsonb_typeof(receipt) = 'object'::text AND octet_length(receipt::text) <= 8192)"
        }
    },
    {
        "kind": "constraint",
        "id": "agent_readiness_trials.agent_readiness_trials_request_check",
        "definition": {
            "type": "c",
            "validated": true,
            "definition": "CHECK (jsonb_typeof(request) = 'object'::text AND octet_length(request::text) <= 2048)"
        }
    },
    {
        "kind": "constraint",
        "id": "agent_readiness_trials.agent_readiness_trials_request_hash_check",
        "definition": {
            "type": "c",
            "validated": true,
            "definition": "CHECK (request_hash ~ '^[a-f0-9]{64}$'::text)"
        }
    },
    {
        "kind": "constraint",
        "id": "agent_readiness_trials.agent_readiness_trials_revision_check",
        "definition": {
            "type": "c",
            "validated": true,
            "definition": "CHECK (revision >= 0)"
        }
    },
    {
        "kind": "constraint",
        "id": "agent_readiness_trials.agent_readiness_trials_snapshot_check",
        "definition": {
            "type": "c",
            "validated": true,
            "definition": "CHECK (jsonb_typeof(snapshot) = 'object'::text AND octet_length(snapshot::text) <= 131072)"
        }
    },
    {
        "kind": "constraint",
        "id": "agent_readiness_trials.agent_readiness_trials_status_check",
        "definition": {
            "type": "c",
            "validated": true,
            "definition": "CHECK (status = ANY (ARRAY['queued'::text, 'running'::text, 'succeeded'::text, 'failed'::text, 'cancelled'::text, 'interrupted'::text]))"
        }
    },
    {
        "kind": "function",
        "id": "agent_readiness_trial_immutable()",
        "definition": {
            "definitionMd5": "3cdb2439428c438df9b1586923b40964"
        }
    },
    {
        "kind": "index",
        "id": "agent_readiness_owner_history",
        "definition": {
            "ready": true,
            "valid": true,
            "definition": "CREATE INDEX agent_readiness_owner_history ON agent_readiness_trials USING btree (owner_email, project_id, agent_id, created_at DESC, id)"
        }
    },
    {
        "kind": "index",
        "id": "agent_readiness_single_pending",
        "definition": {
            "ready": true,
            "valid": true,
            "definition": "CREATE UNIQUE INDEX agent_readiness_single_pending ON agent_readiness_trials USING btree (owner_email, project_id, agent_id) WHERE (status = ANY (ARRAY['queued'::text, 'running'::text]))"
        }
    },
    {
        "kind": "index",
        "id": "agent_readiness_trials_owner_email_request_id_key",
        "definition": {
            "ready": true,
            "valid": true,
            "definition": "CREATE UNIQUE INDEX agent_readiness_trials_owner_email_request_id_key ON agent_readiness_trials USING btree (owner_email, request_id)"
        }
    },
    {
        "kind": "index",
        "id": "agent_readiness_trials_pkey",
        "definition": {
            "ready": true,
            "valid": true,
            "definition": "CREATE UNIQUE INDEX agent_readiness_trials_pkey ON agent_readiness_trials USING btree (id)"
        }
    },
    {
        "kind": "table",
        "id": "agent_readiness_trials",
        "definition": {
            "kind": "r",
            "persistence": "p"
        }
    },
    {
        "kind": "trigger",
        "id": "agent_readiness_trials.agent_readiness_trial_immutable",
        "definition": {
            "enabled": "O",
            "definition": "CREATE TRIGGER agent_readiness_trial_immutable BEFORE UPDATE ON agent_readiness_trials FOR EACH ROW EXECUTE FUNCTION agent_readiness_trial_immutable()"
        }
    },
    {
        "kind": "trigger",
        "id": "agent_readiness_trials.neurocenter_retired_reference_guard",
        "definition": {
            "enabled": "O",
            "definition": "CREATE TRIGGER neurocenter_retired_reference_guard BEFORE INSERT OR UPDATE OF project_id ON agent_readiness_trials FOR EACH ROW EXECUTE FUNCTION neurocenter_retired_reference_guard()"
        }
    }
] as const;
