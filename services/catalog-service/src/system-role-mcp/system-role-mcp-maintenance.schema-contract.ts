/** Migration37 facts measured on the explicitly owned PostgreSQL16.14 acceptance database. */
export const SYSTEM_ROLE_MCP_MAINTENANCE_SCHEMA_CONTRACT = [
    {
        "kind": "column",
        "id": "system_role_mcp_retired_claims.created_at",
        "definition": {
            "type": "timestamp with time zone",
            "default": "now()",
            "notNull": true
        }
    },
    {
        "kind": "column",
        "id": "system_role_mcp_retired_claims.device_id",
        "definition": {
            "type": "text",
            "default": null,
            "notNull": true
        }
    },
    {
        "kind": "column",
        "id": "system_role_mcp_retired_claims.request_id",
        "definition": {
            "type": "uuid",
            "default": null,
            "notNull": true
        }
    },
    {
        "kind": "column",
        "id": "system_role_mcp_retired_claims.token_hash",
        "definition": {
            "type": "text",
            "default": null,
            "notNull": true
        }
    },
    {
        "kind": "column",
        "id": "system_role_mcp_sessions.worker_claim_request_id",
        "definition": {
            "type": "uuid",
            "default": null,
            "notNull": false
        }
    },
    {
        "kind": "column",
        "id": "system_role_mcp_sessions.worker_claim_token_hash",
        "definition": {
            "type": "text",
            "default": null,
            "notNull": false
        }
    },
    {
        "kind": "column",
        "id": "system_role_mcp_sessions.worker_closed_at",
        "definition": {
            "type": "timestamp with time zone",
            "default": null,
            "notNull": false
        }
    },
    {
        "kind": "constraint",
        "id": "system_role_mcp_retired_claims.system_role_mcp_retired_claims_device_id_fkey",
        "definition": {
            "type": "f",
            "validated": true,
            "definition": "FOREIGN KEY (device_id) REFERENCES bridge_devices(id) ON DELETE CASCADE"
        }
    },
    {
        "kind": "constraint",
        "id": "system_role_mcp_retired_claims.system_role_mcp_retired_claims_pkey",
        "definition": {
            "type": "p",
            "validated": true,
            "definition": "PRIMARY KEY (device_id, token_hash, request_id)"
        }
    },
    {
        "kind": "constraint",
        "id": "system_role_mcp_retired_claims.system_role_mcp_retired_claims_token_hash_check",
        "definition": {
            "type": "c",
            "validated": true,
            "definition": "CHECK (token_hash ~ '^[a-f0-9]{64}$'::text)"
        }
    },
    {
        "kind": "constraint",
        "id": "system_role_mcp_sessions.system_role_mcp_worker_claim_check",
        "definition": {
            "type": "c",
            "validated": true,
            "definition": "CHECK ((worker_claim_request_id IS NULL) = (worker_claim_token_hash IS NULL) AND (worker_claim_request_id IS NULL OR (target ->> 'runtime'::text) = 'device'::text AND claimed_at IS NOT NULL AND worker_claim_token_hash ~ '^[a-f0-9]{64}$'::text))"
        }
    },
    {
        "kind": "constraint",
        "id": "system_role_mcp_sessions.system_role_mcp_worker_closed_check",
        "definition": {
            "type": "c",
            "validated": true,
            "definition": "CHECK (worker_closed_at IS NULL OR (target ->> 'runtime'::text) = 'device'::text AND claimed_at IS NOT NULL AND state = 'closed'::text)"
        }
    },
    {
        "kind": "function",
        "id": "system_role_mcp_retired_claim_guard()",
        "definition": {
            "definitionMd5": "09e755d4007930907978236e4fde194d"
        }
    },
    {
        "kind": "function",
        "id": "system_role_mcp_worker_cleanup_guard()",
        "definition": {
            "definitionMd5": "f0696c925dfbe070ed5b8fedd797722f"
        }
    },
    {
        "kind": "index",
        "id": "system_role_mcp_device_claim_request",
        "definition": {
            "ready": true,
            "valid": true,
            "definition": "CREATE UNIQUE INDEX system_role_mcp_device_claim_request ON system_role_mcp_sessions USING btree (((target ->> 'deviceId'::text)), worker_claim_request_id) WHERE (worker_claim_request_id IS NOT NULL)"
        }
    },
    {
        "kind": "index",
        "id": "system_role_mcp_device_cleanup_pending",
        "definition": {
            "ready": true,
            "valid": true,
            "definition": "CREATE INDEX system_role_mcp_device_cleanup_pending ON system_role_mcp_sessions USING btree (((target ->> 'deviceId'::text))) WHERE (((target ->> 'runtime'::text) = 'device'::text) AND (claimed_at IS NOT NULL) AND (worker_closed_at IS NULL))"
        }
    },
    {
        "kind": "index",
        "id": "system_role_mcp_retired_claims_pkey",
        "definition": {
            "ready": true,
            "valid": true,
            "definition": "CREATE UNIQUE INDEX system_role_mcp_retired_claims_pkey ON system_role_mcp_retired_claims USING btree (device_id, token_hash, request_id)"
        }
    },
    {
        "kind": "table",
        "id": "system_role_mcp_retired_claims",
        "definition": {
            "kind": "r",
            "persistence": "p"
        }
    },
    {
        "kind": "trigger",
        "id": "system_role_mcp_retired_claims.system_role_mcp_retired_claim_guard",
        "definition": {
            "enabled": "O",
            "definition": "CREATE TRIGGER system_role_mcp_retired_claim_guard BEFORE DELETE OR UPDATE ON system_role_mcp_retired_claims FOR EACH ROW EXECUTE FUNCTION system_role_mcp_retired_claim_guard()"
        }
    },
    {
        "kind": "trigger",
        "id": "system_role_mcp_sessions.system_role_mcp_worker_cleanup_guard",
        "definition": {
            "enabled": "O",
            "definition": "CREATE TRIGGER system_role_mcp_worker_cleanup_guard BEFORE DELETE OR UPDATE ON system_role_mcp_sessions FOR EACH ROW EXECUTE FUNCTION system_role_mcp_worker_cleanup_guard()"
        }
    }
] as const;
