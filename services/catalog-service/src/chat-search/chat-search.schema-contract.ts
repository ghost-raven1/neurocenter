/** Migration39 physical facts measured on owned PostgreSQL16. */
export const CHAT_SEARCH_SCHEMA_CONTRACT = [
  {
    "kind": "column",
    "id": "chat_search_jobs.active_role",
    "definition": {
      "type": "text",
      "default": null,
      "notNull": true
    }
  },
  {
    "kind": "column",
    "id": "chat_search_jobs.actor",
    "definition": {
      "type": "text",
      "default": null,
      "notNull": true
    }
  },
  {
    "kind": "column",
    "id": "chat_search_jobs.created_at",
    "definition": {
      "type": "timestamp with time zone",
      "default": "now()",
      "notNull": true
    }
  },
  {
    "kind": "column",
    "id": "chat_search_jobs.deadline",
    "definition": {
      "type": "timestamp with time zone",
      "default": null,
      "notNull": true
    }
  },
  {
    "kind": "column",
    "id": "chat_search_jobs.dimension",
    "definition": {
      "type": "integer",
      "default": null,
      "notNull": true
    }
  },
  {
    "kind": "column",
    "id": "chat_search_jobs.error",
    "definition": {
      "type": "text",
      "default": null,
      "notNull": false
    }
  },
  {
    "kind": "column",
    "id": "chat_search_jobs.finished_at",
    "definition": {
      "type": "timestamp with time zone",
      "default": null,
      "notNull": false
    }
  },
  {
    "kind": "column",
    "id": "chat_search_jobs.id",
    "definition": {
      "type": "uuid",
      "default": null,
      "notNull": true
    }
  },
  {
    "kind": "column",
    "id": "chat_search_jobs.kind",
    "definition": {
      "type": "text",
      "default": null,
      "notNull": true
    }
  },
  {
    "kind": "column",
    "id": "chat_search_jobs.model_id",
    "definition": {
      "type": "text",
      "default": null,
      "notNull": true
    }
  },
  {
    "kind": "column",
    "id": "chat_search_jobs.model_pin",
    "definition": {
      "type": "text",
      "default": null,
      "notNull": true
    }
  },
  {
    "kind": "column",
    "id": "chat_search_jobs.project_id",
    "definition": {
      "type": "text",
      "default": null,
      "notNull": true
    }
  },
  {
    "kind": "column",
    "id": "chat_search_jobs.request_hash",
    "definition": {
      "type": "text",
      "default": null,
      "notNull": true
    }
  },
  {
    "kind": "column",
    "id": "chat_search_jobs.request_key",
    "definition": {
      "type": "uuid",
      "default": null,
      "notNull": true
    }
  },
  {
    "kind": "column",
    "id": "chat_search_jobs.result",
    "definition": {
      "type": "jsonb",
      "default": "'{}'::jsonb",
      "notNull": true
    }
  },
  {
    "kind": "column",
    "id": "chat_search_jobs.state",
    "definition": {
      "type": "text",
      "default": null,
      "notNull": true
    }
  },
  {
    "kind": "column",
    "id": "chat_search_revisions.message_id",
    "definition": {
      "type": "uuid",
      "default": null,
      "notNull": true
    }
  },
  {
    "kind": "column",
    "id": "chat_search_revisions.project_id",
    "definition": {
      "type": "text",
      "default": null,
      "notNull": true
    }
  },
  {
    "kind": "column",
    "id": "chat_search_revisions.revision",
    "definition": {
      "type": "bigint",
      "default": "1",
      "notNull": true
    }
  },
  {
    "kind": "column",
    "id": "chat_search_revisions.tombstone",
    "definition": {
      "type": "boolean",
      "default": "false",
      "notNull": true
    }
  },
  {
    "kind": "column",
    "id": "chat_search_vectors.chunk_index",
    "definition": {
      "type": "integer",
      "default": null,
      "notNull": true
    }
  },
  {
    "kind": "column",
    "id": "chat_search_vectors.dimension",
    "definition": {
      "type": "integer",
      "default": null,
      "notNull": true
    }
  },
  {
    "kind": "column",
    "id": "chat_search_vectors.embedding",
    "definition": {
      "type": "double precision[]",
      "default": null,
      "notNull": true
    }
  },
  {
    "kind": "column",
    "id": "chat_search_vectors.indexed_at",
    "definition": {
      "type": "timestamp with time zone",
      "default": "now()",
      "notNull": true
    }
  },
  {
    "kind": "column",
    "id": "chat_search_vectors.message_id",
    "definition": {
      "type": "uuid",
      "default": null,
      "notNull": true
    }
  },
  {
    "kind": "column",
    "id": "chat_search_vectors.model_id",
    "definition": {
      "type": "text",
      "default": null,
      "notNull": true
    }
  },
  {
    "kind": "column",
    "id": "chat_search_vectors.model_pin",
    "definition": {
      "type": "text",
      "default": null,
      "notNull": true
    }
  },
  {
    "kind": "column",
    "id": "chat_search_vectors.project_id",
    "definition": {
      "type": "text",
      "default": null,
      "notNull": true
    }
  },
  {
    "kind": "column",
    "id": "chat_search_vectors.revision",
    "definition": {
      "type": "bigint",
      "default": null,
      "notNull": true
    }
  },
  {
    "kind": "constraint",
    "id": "chat_search_jobs.chat_search_jobs_dimension_check",
    "definition": {
      "type": "c",
      "validated": true,
      "definition": "CHECK (dimension >= 1 AND dimension <= 16000)"
    }
  },
  {
    "kind": "constraint",
    "id": "chat_search_jobs.chat_search_jobs_kind_check",
    "definition": {
      "type": "c",
      "validated": true,
      "definition": "CHECK (kind = ANY (ARRAY['index'::text, 'search'::text]))"
    }
  },
  {
    "kind": "constraint",
    "id": "chat_search_jobs.chat_search_jobs_model_pin_check",
    "definition": {
      "type": "c",
      "validated": true,
      "definition": "CHECK (model_pin ~ '^[a-f0-9]{64}$'::text)"
    }
  },
  {
    "kind": "constraint",
    "id": "chat_search_jobs.chat_search_jobs_pkey",
    "definition": {
      "type": "p",
      "validated": true,
      "definition": "PRIMARY KEY (id)"
    }
  },
  {
    "kind": "constraint",
    "id": "chat_search_jobs.chat_search_jobs_project_id_actor_request_key_key",
    "definition": {
      "type": "u",
      "validated": true,
      "definition": "UNIQUE (project_id, actor, request_key)"
    }
  },
  {
    "kind": "constraint",
    "id": "chat_search_jobs.chat_search_jobs_project_id_fkey",
    "definition": {
      "type": "f",
      "validated": true,
      "definition": "FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE"
    }
  },
  {
    "kind": "constraint",
    "id": "chat_search_jobs.chat_search_jobs_request_hash_check",
    "definition": {
      "type": "c",
      "validated": true,
      "definition": "CHECK (request_hash ~ '^[a-f0-9]{64}$'::text)"
    }
  },
  {
    "kind": "constraint",
    "id": "chat_search_jobs.chat_search_jobs_result_check",
    "definition": {
      "type": "c",
      "validated": true,
      "definition": "CHECK (jsonb_typeof(result) = 'object'::text AND octet_length(result::text) <= 32768)"
    }
  },
  {
    "kind": "constraint",
    "id": "chat_search_jobs.chat_search_jobs_state_check",
    "definition": {
      "type": "c",
      "validated": true,
      "definition": "CHECK (state = ANY (ARRAY['RUNNING'::text, 'SUCCEEDED'::text, 'FAILED'::text, 'CANCELLED'::text]))"
    }
  },
  {
    "kind": "constraint",
    "id": "chat_search_revisions.chat_search_revisions_pkey",
    "definition": {
      "type": "p",
      "validated": true,
      "definition": "PRIMARY KEY (project_id, message_id)"
    }
  },
  {
    "kind": "constraint",
    "id": "chat_search_revisions.chat_search_revisions_project_id_fkey",
    "definition": {
      "type": "f",
      "validated": true,
      "definition": "FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE"
    }
  },
  {
    "kind": "constraint",
    "id": "chat_search_revisions.chat_search_revisions_revision_check",
    "definition": {
      "type": "c",
      "validated": true,
      "definition": "CHECK (revision > 0)"
    }
  },
  {
    "kind": "constraint",
    "id": "chat_search_vectors.chat_search_vectors_check",
    "definition": {
      "type": "c",
      "validated": true,
      "definition": "CHECK (cardinality(embedding) = dimension AND array_ndims(embedding) = 1 AND array_lower(embedding, 1) = 1)"
    }
  },
  {
    "kind": "constraint",
    "id": "chat_search_vectors.chat_search_vectors_chunk_index_check",
    "definition": {
      "type": "c",
      "validated": true,
      "definition": "CHECK (chunk_index >= 0)"
    }
  },
  {
    "kind": "constraint",
    "id": "chat_search_vectors.chat_search_vectors_dimension_check",
    "definition": {
      "type": "c",
      "validated": true,
      "definition": "CHECK (dimension >= 1 AND dimension <= 16000)"
    }
  },
  {
    "kind": "constraint",
    "id": "chat_search_vectors.chat_search_vectors_model_pin_check",
    "definition": {
      "type": "c",
      "validated": true,
      "definition": "CHECK (model_pin ~ '^[a-f0-9]{64}$'::text)"
    }
  },
  {
    "kind": "constraint",
    "id": "chat_search_vectors.chat_search_vectors_pkey",
    "definition": {
      "type": "p",
      "validated": true,
      "definition": "PRIMARY KEY (project_id, message_id, model_id, model_pin, chunk_index)"
    }
  },
  {
    "kind": "constraint",
    "id": "chat_search_vectors.chat_search_vectors_project_id_message_id_fkey",
    "definition": {
      "type": "f",
      "validated": true,
      "definition": "FOREIGN KEY (project_id, message_id) REFERENCES project_chat_messages(project_id, id) ON DELETE CASCADE"
    }
  },
  {
    "kind": "constraint",
    "id": "chat_search_vectors.chat_search_vectors_revision_check",
    "definition": {
      "type": "c",
      "validated": true,
      "definition": "CHECK (revision > 0)"
    }
  },
  {
    "kind": "function",
    "id": "neurocenter_chat_search_revision()",
    "definition": {
      "definitionMd5": "d5eb23950a1b1ac96dd85a124be01355"
    }
  },
  {
    "kind": "index",
    "id": "chat_search_actor_running",
    "definition": {
      "ready": true,
      "valid": true,
      "definition": "CREATE UNIQUE INDEX chat_search_actor_running ON chat_search_jobs USING btree (project_id, actor) WHERE (state = 'RUNNING'::text)"
    }
  },
  {
    "kind": "index",
    "id": "chat_search_jobs_pkey",
    "definition": {
      "ready": true,
      "valid": true,
      "definition": "CREATE UNIQUE INDEX chat_search_jobs_pkey ON chat_search_jobs USING btree (id)"
    }
  },
  {
    "kind": "index",
    "id": "chat_search_jobs_project_id_actor_request_key_key",
    "definition": {
      "ready": true,
      "valid": true,
      "definition": "CREATE UNIQUE INDEX chat_search_jobs_project_id_actor_request_key_key ON chat_search_jobs USING btree (project_id, actor, request_key)"
    }
  },
  {
    "kind": "index",
    "id": "chat_search_revisions_pkey",
    "definition": {
      "ready": true,
      "valid": true,
      "definition": "CREATE UNIQUE INDEX chat_search_revisions_pkey ON chat_search_revisions USING btree (project_id, message_id)"
    }
  },
  {
    "kind": "index",
    "id": "chat_search_vector_profile",
    "definition": {
      "ready": true,
      "valid": true,
      "definition": "CREATE INDEX chat_search_vector_profile ON chat_search_vectors USING btree (project_id, model_id, model_pin, message_id, chunk_index)"
    }
  },
  {
    "kind": "index",
    "id": "chat_search_vectors_pkey",
    "definition": {
      "ready": true,
      "valid": true,
      "definition": "CREATE UNIQUE INDEX chat_search_vectors_pkey ON chat_search_vectors USING btree (project_id, message_id, model_id, model_pin, chunk_index)"
    }
  },
  {
    "kind": "table",
    "id": "chat_search_jobs",
    "definition": {
      "kind": "r",
      "persistence": "p"
    }
  },
  {
    "kind": "table",
    "id": "chat_search_revisions",
    "definition": {
      "kind": "r",
      "persistence": "p"
    }
  },
  {
    "kind": "table",
    "id": "chat_search_vectors",
    "definition": {
      "kind": "r",
      "persistence": "p"
    }
  },
  {
    "kind": "trigger",
    "id": "project_chat_messages.chat_search_revision",
    "definition": {
      "enabled": "O",
      "definition": "CREATE TRIGGER chat_search_revision AFTER INSERT OR DELETE OR UPDATE ON project_chat_messages FOR EACH ROW EXECUTE FUNCTION neurocenter_chat_search_revision()"
    }
  }
];
