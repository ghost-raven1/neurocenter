/** Migration41 physical facts measured on owned PostgreSQL16. */
export const PLUGIN_AUTO_UPDATE_SCHEMA_CONTRACT = [
  {
    "kind": "column",
    "id": "plugin_auto_update_policies.actor_role",
    "definition": {
      "type": "text",
      "default": null,
      "notNull": true
    }
  },
  {
    "kind": "column",
    "id": "plugin_auto_update_policies.asset_id",
    "definition": {
      "type": "text",
      "default": null,
      "notNull": true
    }
  },
  {
    "kind": "column",
    "id": "plugin_auto_update_policies.binding_id",
    "definition": {
      "type": "text",
      "default": null,
      "notNull": true
    }
  },
  {
    "kind": "column",
    "id": "plugin_auto_update_policies.checked_at",
    "definition": {
      "type": "timestamp with time zone",
      "default": null,
      "notNull": false
    }
  },
  {
    "kind": "column",
    "id": "plugin_auto_update_policies.device_id",
    "definition": {
      "type": "text",
      "default": null,
      "notNull": true
    }
  },
  {
    "kind": "column",
    "id": "plugin_auto_update_policies.enabled",
    "definition": {
      "type": "boolean",
      "default": null,
      "notNull": true
    }
  },
  {
    "kind": "column",
    "id": "plugin_auto_update_policies.id",
    "definition": {
      "type": "uuid",
      "default": null,
      "notNull": true
    }
  },
  {
    "kind": "column",
    "id": "plugin_auto_update_policies.job_id",
    "definition": {
      "type": "text",
      "default": null,
      "notNull": false
    }
  },
  {
    "kind": "column",
    "id": "plugin_auto_update_policies.lease_token",
    "definition": {
      "type": "uuid",
      "default": null,
      "notNull": false
    }
  },
  {
    "kind": "column",
    "id": "plugin_auto_update_policies.lease_until",
    "definition": {
      "type": "timestamp with time zone",
      "default": null,
      "notNull": false
    }
  },
  {
    "kind": "column",
    "id": "plugin_auto_update_policies.message",
    "definition": {
      "type": "text",
      "default": null,
      "notNull": true
    }
  },
  {
    "kind": "column",
    "id": "plugin_auto_update_policies.mutation_hash",
    "definition": {
      "type": "text",
      "default": null,
      "notNull": true
    }
  },
  {
    "kind": "column",
    "id": "plugin_auto_update_policies.mutation_key",
    "definition": {
      "type": "uuid",
      "default": null,
      "notNull": true
    }
  },
  {
    "kind": "column",
    "id": "plugin_auto_update_policies.next_check_at",
    "definition": {
      "type": "timestamp with time zone",
      "default": null,
      "notNull": false
    }
  },
  {
    "kind": "column",
    "id": "plugin_auto_update_policies.owner_email",
    "definition": {
      "type": "text",
      "default": null,
      "notNull": true
    }
  },
  {
    "kind": "column",
    "id": "plugin_auto_update_policies.pending_input",
    "definition": {
      "type": "jsonb",
      "default": null,
      "notNull": false
    }
  },
  {
    "kind": "column",
    "id": "plugin_auto_update_policies.pending_role",
    "definition": {
      "type": "text",
      "default": null,
      "notNull": false
    }
  },
  {
    "kind": "column",
    "id": "plugin_auto_update_policies.project_id",
    "definition": {
      "type": "text",
      "default": null,
      "notNull": true
    }
  },
  {
    "kind": "column",
    "id": "plugin_auto_update_policies.revision",
    "definition": {
      "type": "integer",
      "default": "1",
      "notNull": true
    }
  },
  {
    "kind": "column",
    "id": "plugin_auto_update_policies.status",
    "definition": {
      "type": "text",
      "default": null,
      "notNull": true
    }
  },
  {
    "kind": "constraint",
    "id": "plugin_auto_update_policies.plugin_auto_update_policies_binding_id_check",
    "definition": {
      "type": "c",
      "validated": true,
      "definition": "CHECK (binding_id ~ '^[a-f0-9]{64}$'::text)"
    }
  },
  {
    "kind": "constraint",
    "id": "plugin_auto_update_policies.plugin_auto_update_policies_check",
    "definition": {
      "type": "c",
      "validated": true,
      "definition": "CHECK ((pending_input IS NULL) = (pending_role IS NULL))"
    }
  },
  {
    "kind": "constraint",
    "id": "plugin_auto_update_policies.plugin_auto_update_policies_check1",
    "definition": {
      "type": "c",
      "validated": true,
      "definition": "CHECK ((lease_token IS NULL) = (lease_until IS NULL))"
    }
  },
  {
    "kind": "constraint",
    "id": "plugin_auto_update_policies.plugin_auto_update_policies_device_id_fkey",
    "definition": {
      "type": "f",
      "validated": true,
      "definition": "FOREIGN KEY (device_id) REFERENCES bridge_devices(id) ON DELETE CASCADE"
    }
  },
  {
    "kind": "constraint",
    "id": "plugin_auto_update_policies.plugin_auto_update_policies_job_id_fkey",
    "definition": {
      "type": "f",
      "validated": true,
      "definition": "FOREIGN KEY (job_id) REFERENCES bridge_jobs(id)"
    }
  },
  {
    "kind": "constraint",
    "id": "plugin_auto_update_policies.plugin_auto_update_policies_message_check",
    "definition": {
      "type": "c",
      "validated": true,
      "definition": "CHECK (octet_length(message) <= 4096)"
    }
  },
  {
    "kind": "constraint",
    "id": "plugin_auto_update_policies.plugin_auto_update_policies_mutation_hash_check",
    "definition": {
      "type": "c",
      "validated": true,
      "definition": "CHECK (mutation_hash ~ '^[a-f0-9]{64}$'::text)"
    }
  },
  {
    "kind": "constraint",
    "id": "plugin_auto_update_policies.plugin_auto_update_policies_owner_email_device_id_project_i_key",
    "definition": {
      "type": "u",
      "validated": true,
      "definition": "UNIQUE (owner_email, device_id, project_id, binding_id, asset_id)"
    }
  },
  {
    "kind": "constraint",
    "id": "plugin_auto_update_policies.plugin_auto_update_policies_pending_input_check",
    "definition": {
      "type": "c",
      "validated": true,
      "definition": "CHECK (pending_input IS NULL OR jsonb_typeof(pending_input) = 'object'::text AND octet_length(pending_input::text) <= 16384)"
    }
  },
  {
    "kind": "constraint",
    "id": "plugin_auto_update_policies.plugin_auto_update_policies_pkey",
    "definition": {
      "type": "p",
      "validated": true,
      "definition": "PRIMARY KEY (id)"
    }
  },
  {
    "kind": "constraint",
    "id": "plugin_auto_update_policies.plugin_auto_update_policies_project_id_fkey",
    "definition": {
      "type": "f",
      "validated": true,
      "definition": "FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE"
    }
  },
  {
    "kind": "constraint",
    "id": "plugin_auto_update_policies.plugin_auto_update_policies_revision_check",
    "definition": {
      "type": "c",
      "validated": true,
      "definition": "CHECK (revision > 0)"
    }
  },
  {
    "kind": "constraint",
    "id": "plugin_auto_update_policies.plugin_auto_update_policies_status_check",
    "definition": {
      "type": "c",
      "validated": true,
      "definition": "CHECK (status = ANY (ARRAY['disabled'::text, 'waiting'::text, 'up-to-date'::text, 'queued'::text, 'succeeded'::text, 'attention'::text]))"
    }
  },
  {
    "kind": "function",
    "id": "plugin_auto_update_identity_guard()",
    "definition": {
      "definitionMd5": "ab939c11e9cf19bbd26cc06ffac4f478"
    }
  },
  {
    "kind": "index",
    "id": "plugin_auto_update_due",
    "definition": {
      "ready": true,
      "valid": true,
      "definition": "CREATE INDEX plugin_auto_update_due ON plugin_auto_update_policies USING btree (next_check_at) WHERE enabled"
    }
  },
  {
    "kind": "index",
    "id": "plugin_auto_update_policies_owner_email_device_id_project_i_key",
    "definition": {
      "ready": true,
      "valid": true,
      "definition": "CREATE UNIQUE INDEX plugin_auto_update_policies_owner_email_device_id_project_i_key ON plugin_auto_update_policies USING btree (owner_email, device_id, project_id, binding_id, asset_id)"
    }
  },
  {
    "kind": "index",
    "id": "plugin_auto_update_policies_pkey",
    "definition": {
      "ready": true,
      "valid": true,
      "definition": "CREATE UNIQUE INDEX plugin_auto_update_policies_pkey ON plugin_auto_update_policies USING btree (id)"
    }
  },
  {
    "kind": "table",
    "id": "plugin_auto_update_policies",
    "definition": {
      "kind": "r",
      "persistence": "p"
    }
  },
  {
    "kind": "trigger",
    "id": "plugin_auto_update_policies.plugin_auto_update_identity_guard",
    "definition": {
      "enabled": "O",
      "definition": "CREATE TRIGGER plugin_auto_update_identity_guard BEFORE UPDATE ON plugin_auto_update_policies FOR EACH ROW EXECUTE FUNCTION plugin_auto_update_identity_guard()"
    }
  }
];
