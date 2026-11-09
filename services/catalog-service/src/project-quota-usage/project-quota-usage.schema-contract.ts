/** Migration53 physical facts measured on owned PostgreSQL16. */
export const PROJECT_QUOTA_USAGE_SCHEMA_CONTRACT = [
  {
    "kind": "column",
    "id": "project_quota_usage_requests.created_at",
    "definition": {
      "type": "timestamp with time zone",
      "default": "clock_timestamp()",
      "notNull": true
    }
  },
  {
    "kind": "column",
    "id": "project_quota_usage_requests.delta_bytes",
    "definition": {
      "type": "bigint",
      "default": null,
      "notNull": true
    }
  },
  {
    "kind": "column",
    "id": "project_quota_usage_requests.dimension",
    "definition": {
      "type": "text",
      "default": null,
      "notNull": true
    }
  },
  {
    "kind": "column",
    "id": "project_quota_usage_requests.project_id",
    "definition": {
      "type": "text",
      "default": null,
      "notNull": true
    }
  },
  {
    "kind": "column",
    "id": "project_quota_usage_requests.request_key",
    "definition": {
      "type": "text",
      "default": null,
      "notNull": true
    }
  },
  {
    "kind": "column",
    "id": "project_quota_usage.dimension",
    "definition": {
      "type": "text",
      "default": null,
      "notNull": true
    }
  },
  {
    "kind": "column",
    "id": "project_quota_usage.project_id",
    "definition": {
      "type": "text",
      "default": null,
      "notNull": true
    }
  },
  {
    "kind": "column",
    "id": "project_quota_usage.updated_at",
    "definition": {
      "type": "timestamp with time zone",
      "default": "clock_timestamp()",
      "notNull": true
    }
  },
  {
    "kind": "column",
    "id": "project_quota_usage.used_bytes",
    "definition": {
      "type": "bigint",
      "default": "0",
      "notNull": true
    }
  },
  {
    "kind": "constraint",
    "id": "project_quota_usage_requests.project_quota_usage_requests_delta_bytes_check",
    "definition": {
      "type": "c",
      "validated": true,
      "definition": "CHECK (delta_bytes <> 0 AND delta_bytes >= '-9007199254740991'::bigint AND delta_bytes <= '9007199254740991'::bigint)"
    }
  },
  {
    "kind": "constraint",
    "id": "project_quota_usage_requests.project_quota_usage_requests_dimension_check",
    "definition": {
      "type": "c",
      "validated": true,
      "definition": "CHECK (dimension = ANY (ARRAY['current'::text, 'retention'::text, 'staging'::text]))"
    }
  },
  {
    "kind": "constraint",
    "id": "project_quota_usage_requests.project_quota_usage_requests_pkey",
    "definition": {
      "type": "p",
      "validated": true,
      "definition": "PRIMARY KEY (project_id, dimension, request_key)"
    }
  },
  {
    "kind": "constraint",
    "id": "project_quota_usage_requests.project_quota_usage_requests_project_id_fkey",
    "definition": {
      "type": "f",
      "validated": true,
      "definition": "FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE"
    }
  },
  {
    "kind": "constraint",
    "id": "project_quota_usage_requests.project_quota_usage_requests_request_key_check",
    "definition": {
      "type": "c",
      "validated": true,
      "definition": "CHECK (length(request_key) <= 512)"
    }
  },
  {
    "kind": "constraint",
    "id": "project_quota_usage.project_quota_usage_dimension_check",
    "definition": {
      "type": "c",
      "validated": true,
      "definition": "CHECK (dimension = ANY (ARRAY['current'::text, 'retention'::text, 'staging'::text]))"
    }
  },
  {
    "kind": "constraint",
    "id": "project_quota_usage.project_quota_usage_pkey",
    "definition": {
      "type": "p",
      "validated": true,
      "definition": "PRIMARY KEY (project_id, dimension)"
    }
  },
  {
    "kind": "constraint",
    "id": "project_quota_usage.project_quota_usage_project_id_fkey",
    "definition": {
      "type": "f",
      "validated": true,
      "definition": "FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE"
    }
  },
  {
    "kind": "constraint",
    "id": "project_quota_usage.project_quota_usage_used_bytes_check",
    "definition": {
      "type": "c",
      "validated": true,
      "definition": "CHECK (used_bytes >= 0)"
    }
  },
  {
    "kind": "index",
    "id": "project_quota_usage_pkey",
    "definition": {
      "ready": true,
      "valid": true,
      "definition": "CREATE UNIQUE INDEX project_quota_usage_pkey ON project_quota_usage USING btree (project_id, dimension)"
    }
  },
  {
    "kind": "index",
    "id": "project_quota_usage_requests_pkey",
    "definition": {
      "ready": true,
      "valid": true,
      "definition": "CREATE UNIQUE INDEX project_quota_usage_requests_pkey ON project_quota_usage_requests USING btree (project_id, dimension, request_key)"
    }
  },
  {
    "kind": "table",
    "id": "project_quota_usage",
    "definition": {
      "kind": "r",
      "persistence": "p"
    }
  },
  {
    "kind": "table",
    "id": "project_quota_usage_requests",
    "definition": {
      "kind": "r",
      "persistence": "p"
    }
  }
];
