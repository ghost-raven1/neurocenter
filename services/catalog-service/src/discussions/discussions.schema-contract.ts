/** Migration 22 physical facts, measured on isolated PostgreSQL 16.15. */
export const DISCUSSIONS_SCHEMA_CONTRACT = [
    {
        "kind": "column",
        "id": "catalog_reactions.actor_email",
        "definition": {
            "type": "text",
            "default": null,
            "notNull": true
        }
    },
    {
        "kind": "column",
        "id": "catalog_reactions.created_at",
        "definition": {
            "type": "timestamp with time zone",
            "default": "now()",
            "notNull": true
        }
    },
    {
        "kind": "column",
        "id": "catalog_reactions.target_id",
        "definition": {
            "type": "text",
            "default": null,
            "notNull": true
        }
    },
    {
        "kind": "column",
        "id": "discussion_attachments.bucket",
        "definition": {
            "type": "text",
            "default": null,
            "notNull": true
        }
    },
    {
        "kind": "column",
        "id": "discussion_attachments.bytes",
        "definition": {
            "type": "integer",
            "default": null,
            "notNull": true
        }
    },
    {
        "kind": "column",
        "id": "discussion_attachments.comment_id",
        "definition": {
            "type": "uuid",
            "default": null,
            "notNull": false
        }
    },
    {
        "kind": "column",
        "id": "discussion_attachments.created_at",
        "definition": {
            "type": "timestamp with time zone",
            "default": "now()",
            "notNull": true
        }
    },
    {
        "kind": "column",
        "id": "discussion_attachments.id",
        "definition": {
            "type": "uuid",
            "default": null,
            "notNull": true
        }
    },
    {
        "kind": "column",
        "id": "discussion_attachments.media_type",
        "definition": {
            "type": "text",
            "default": null,
            "notNull": true
        }
    },
    {
        "kind": "column",
        "id": "discussion_attachments.name",
        "definition": {
            "type": "text",
            "default": null,
            "notNull": true
        }
    },
    {
        "kind": "column",
        "id": "discussion_attachments.object_key",
        "definition": {
            "type": "text",
            "default": null,
            "notNull": true
        }
    },
    {
        "kind": "column",
        "id": "discussion_attachments.owner_email",
        "definition": {
            "type": "text",
            "default": null,
            "notNull": true
        }
    },
    {
        "kind": "column",
        "id": "discussion_attachments.request_key",
        "definition": {
            "type": "uuid",
            "default": null,
            "notNull": true
        }
    },
    {
        "kind": "column",
        "id": "discussion_attachments.sha256",
        "definition": {
            "type": "text",
            "default": null,
            "notNull": true
        }
    },
    {
        "kind": "column",
        "id": "discussion_attachments.state",
        "definition": {
            "type": "text",
            "default": null,
            "notNull": true
        }
    },
    {
        "kind": "column",
        "id": "discussion_attachments.storage_id",
        "definition": {
            "type": "text",
            "default": null,
            "notNull": true
        }
    },
    {
        "kind": "column",
        "id": "discussion_attachments.target_id",
        "definition": {
            "type": "text",
            "default": null,
            "notNull": true
        }
    },
    {
        "kind": "column",
        "id": "discussion_attachments.target_type",
        "definition": {
            "type": "text",
            "default": null,
            "notNull": true
        }
    },
    {
        "kind": "column",
        "id": "discussion_attachments.version_id",
        "definition": {
            "type": "text",
            "default": null,
            "notNull": false
        }
    },
    {
        "kind": "column",
        "id": "discussion_comments.author_email",
        "definition": {
            "type": "text",
            "default": null,
            "notNull": true
        }
    },
    {
        "kind": "column",
        "id": "discussion_comments.author_name",
        "definition": {
            "type": "text",
            "default": null,
            "notNull": true
        }
    },
    {
        "kind": "column",
        "id": "discussion_comments.body",
        "definition": {
            "type": "text",
            "default": null,
            "notNull": true
        }
    },
    {
        "kind": "column",
        "id": "discussion_comments.created_at",
        "definition": {
            "type": "timestamp with time zone",
            "default": "now()",
            "notNull": true
        }
    },
    {
        "kind": "column",
        "id": "discussion_comments.deleted_at",
        "definition": {
            "type": "timestamp with time zone",
            "default": null,
            "notNull": false
        }
    },
    {
        "kind": "column",
        "id": "discussion_comments.id",
        "definition": {
            "type": "uuid",
            "default": null,
            "notNull": true
        }
    },
    {
        "kind": "column",
        "id": "discussion_comments.parent_id",
        "definition": {
            "type": "uuid",
            "default": null,
            "notNull": false
        }
    },
    {
        "kind": "column",
        "id": "discussion_comments.request_hash",
        "definition": {
            "type": "text",
            "default": null,
            "notNull": true
        }
    },
    {
        "kind": "column",
        "id": "discussion_comments.request_key",
        "definition": {
            "type": "uuid",
            "default": null,
            "notNull": true
        }
    },
    {
        "kind": "column",
        "id": "discussion_comments.target_id",
        "definition": {
            "type": "text",
            "default": null,
            "notNull": true
        }
    },
    {
        "kind": "column",
        "id": "discussion_comments.target_type",
        "definition": {
            "type": "text",
            "default": null,
            "notNull": true
        }
    },
    {
        "kind": "column",
        "id": "discussion_comments.updated_at",
        "definition": {
            "type": "timestamp with time zone",
            "default": "now()",
            "notNull": true
        }
    },
    {
        "kind": "column",
        "id": "discussion_comments.version",
        "definition": {
            "type": "integer",
            "default": "1",
            "notNull": true
        }
    },
    {
        "kind": "constraint",
        "id": "catalog_reactions.catalog_reactions_pkey",
        "definition": {
            "type": "p",
            "validated": true,
            "definition": "PRIMARY KEY (target_id, actor_email)"
        }
    },
    {
        "kind": "constraint",
        "id": "catalog_reactions.catalog_reactions_target_id_check",
        "definition": {
            "type": "c",
            "validated": true,
            "definition": "CHECK (length(target_id) >= 1 AND length(target_id) <= 600)"
        }
    },
    {
        "kind": "constraint",
        "id": "discussion_attachments.discussion_attachments_bytes_check",
        "definition": {
            "type": "c",
            "validated": true,
            "definition": "CHECK (bytes >= 1 AND bytes <= 10485760)"
        }
    },
    {
        "kind": "constraint",
        "id": "discussion_attachments.discussion_attachments_check",
        "definition": {
            "type": "c",
            "validated": true,
            "definition": "CHECK (comment_id IS NULL OR state = 'READY'::text)"
        }
    },
    {
        "kind": "constraint",
        "id": "discussion_attachments.discussion_attachments_comment_id_target_type_target_id_fkey",
        "definition": {
            "type": "f",
            "validated": true,
            "definition": "FOREIGN KEY (comment_id, target_type, target_id) REFERENCES discussion_comments(id, target_type, target_id) ON DELETE RESTRICT"
        }
    },
    {
        "kind": "constraint",
        "id": "discussion_attachments.discussion_attachments_name_check",
        "definition": {
            "type": "c",
            "validated": true,
            "definition": "CHECK (length(name) >= 1 AND length(name) <= 240)"
        }
    },
    {
        "kind": "constraint",
        "id": "discussion_attachments.discussion_attachments_object_key_key",
        "definition": {
            "type": "u",
            "validated": true,
            "definition": "UNIQUE (object_key)"
        }
    },
    {
        "kind": "constraint",
        "id": "discussion_attachments.discussion_attachments_owner_email_request_key_key",
        "definition": {
            "type": "u",
            "validated": true,
            "definition": "UNIQUE (owner_email, request_key)"
        }
    },
    {
        "kind": "constraint",
        "id": "discussion_attachments.discussion_attachments_pkey",
        "definition": {
            "type": "p",
            "validated": true,
            "definition": "PRIMARY KEY (id)"
        }
    },
    {
        "kind": "constraint",
        "id": "discussion_attachments.discussion_attachments_sha256_check",
        "definition": {
            "type": "c",
            "validated": true,
            "definition": "CHECK (sha256 ~ '^[a-f0-9]{64}$'::text)"
        }
    },
    {
        "kind": "constraint",
        "id": "discussion_attachments.discussion_attachments_state_check",
        "definition": {
            "type": "c",
            "validated": true,
            "definition": "CHECK (state = ANY (ARRAY['UPLOADING'::text, 'READY'::text, 'DELETED'::text, 'PURGED'::text]))"
        }
    },
    {
        "kind": "constraint",
        "id": "discussion_attachments.discussion_attachments_storage_id_check",
        "definition": {
            "type": "c",
            "validated": true,
            "definition": "CHECK (storage_id ~ '^[a-f0-9]{64}$'::text)"
        }
    },
    {
        "kind": "constraint",
        "id": "discussion_attachments.discussion_attachments_target_id_check",
        "definition": {
            "type": "c",
            "validated": true,
            "definition": "CHECK (length(target_id) >= 1 AND length(target_id) <= 600)"
        }
    },
    {
        "kind": "constraint",
        "id": "discussion_attachments.discussion_attachments_target_type_check",
        "definition": {
            "type": "c",
            "validated": true,
            "definition": "CHECK (target_type = ANY (ARRAY['catalog'::text, 'help'::text]))"
        }
    },
    {
        "kind": "constraint",
        "id": "discussion_comments.discussion_comments_author_email_request_key_key",
        "definition": {
            "type": "u",
            "validated": true,
            "definition": "UNIQUE (author_email, request_key)"
        }
    },
    {
        "kind": "constraint",
        "id": "discussion_comments.discussion_comments_body_check",
        "definition": {
            "type": "c",
            "validated": true,
            "definition": "CHECK (octet_length(body) <= 16000)"
        }
    },
    {
        "kind": "constraint",
        "id": "discussion_comments.discussion_comments_check",
        "definition": {
            "type": "c",
            "validated": true,
            "definition": "CHECK (deleted_at IS NULL AND length(body) > 0 OR deleted_at IS NOT NULL AND body = ''::text)"
        }
    },
    {
        "kind": "constraint",
        "id": "discussion_comments.discussion_comments_id_target_type_target_id_key",
        "definition": {
            "type": "u",
            "validated": true,
            "definition": "UNIQUE (id, target_type, target_id)"
        }
    },
    {
        "kind": "constraint",
        "id": "discussion_comments.discussion_comments_parent_id_target_type_target_id_fkey",
        "definition": {
            "type": "f",
            "validated": true,
            "definition": "FOREIGN KEY (parent_id, target_type, target_id) REFERENCES discussion_comments(id, target_type, target_id) ON DELETE RESTRICT"
        }
    },
    {
        "kind": "constraint",
        "id": "discussion_comments.discussion_comments_pkey",
        "definition": {
            "type": "p",
            "validated": true,
            "definition": "PRIMARY KEY (id)"
        }
    },
    {
        "kind": "constraint",
        "id": "discussion_comments.discussion_comments_request_hash_check",
        "definition": {
            "type": "c",
            "validated": true,
            "definition": "CHECK (request_hash ~ '^[a-f0-9]{64}$'::text)"
        }
    },
    {
        "kind": "constraint",
        "id": "discussion_comments.discussion_comments_target_id_check",
        "definition": {
            "type": "c",
            "validated": true,
            "definition": "CHECK (length(target_id) >= 1 AND length(target_id) <= 600)"
        }
    },
    {
        "kind": "constraint",
        "id": "discussion_comments.discussion_comments_target_type_check",
        "definition": {
            "type": "c",
            "validated": true,
            "definition": "CHECK (target_type = ANY (ARRAY['catalog'::text, 'help'::text]))"
        }
    },
    {
        "kind": "constraint",
        "id": "discussion_comments.discussion_comments_version_check",
        "definition": {
            "type": "c",
            "validated": true,
            "definition": "CHECK (version > 0)"
        }
    },
    {
        "kind": "index",
        "id": "catalog_reactions_pkey",
        "definition": {
            "ready": true,
            "valid": true,
            "definition": "CREATE UNIQUE INDEX catalog_reactions_pkey ON catalog_reactions USING btree (target_id, actor_email)"
        }
    },
    {
        "kind": "index",
        "id": "discussion_attachment_cleanup",
        "definition": {
            "ready": true,
            "valid": true,
            "definition": "CREATE INDEX discussion_attachment_cleanup ON discussion_attachments USING btree (state, created_at) WHERE (comment_id IS NULL)"
        }
    },
    {
        "kind": "index",
        "id": "discussion_attachment_comment",
        "definition": {
            "ready": true,
            "valid": true,
            "definition": "CREATE INDEX discussion_attachment_comment ON discussion_attachments USING btree (comment_id)"
        }
    },
    {
        "kind": "index",
        "id": "discussion_attachments_object_key_key",
        "definition": {
            "ready": true,
            "valid": true,
            "definition": "CREATE UNIQUE INDEX discussion_attachments_object_key_key ON discussion_attachments USING btree (object_key)"
        }
    },
    {
        "kind": "index",
        "id": "discussion_attachments_owner_email_request_key_key",
        "definition": {
            "ready": true,
            "valid": true,
            "definition": "CREATE UNIQUE INDEX discussion_attachments_owner_email_request_key_key ON discussion_attachments USING btree (owner_email, request_key)"
        }
    },
    {
        "kind": "index",
        "id": "discussion_attachments_pkey",
        "definition": {
            "ready": true,
            "valid": true,
            "definition": "CREATE UNIQUE INDEX discussion_attachments_pkey ON discussion_attachments USING btree (id)"
        }
    },
    {
        "kind": "index",
        "id": "discussion_comment_target",
        "definition": {
            "ready": true,
            "valid": true,
            "definition": "CREATE INDEX discussion_comment_target ON discussion_comments USING btree (target_type, target_id, created_at, id)"
        }
    },
    {
        "kind": "index",
        "id": "discussion_comments_author_email_request_key_key",
        "definition": {
            "ready": true,
            "valid": true,
            "definition": "CREATE UNIQUE INDEX discussion_comments_author_email_request_key_key ON discussion_comments USING btree (author_email, request_key)"
        }
    },
    {
        "kind": "index",
        "id": "discussion_comments_id_target_type_target_id_key",
        "definition": {
            "ready": true,
            "valid": true,
            "definition": "CREATE UNIQUE INDEX discussion_comments_id_target_type_target_id_key ON discussion_comments USING btree (id, target_type, target_id)"
        }
    },
    {
        "kind": "index",
        "id": "discussion_comments_pkey",
        "definition": {
            "ready": true,
            "valid": true,
            "definition": "CREATE UNIQUE INDEX discussion_comments_pkey ON discussion_comments USING btree (id)"
        }
    },
    {
        "kind": "table",
        "id": "catalog_reactions",
        "definition": {
            "kind": "r",
            "persistence": "p"
        }
    },
    {
        "kind": "table",
        "id": "discussion_attachments",
        "definition": {
            "kind": "r",
            "persistence": "p"
        }
    },
    {
        "kind": "table",
        "id": "discussion_comments",
        "definition": {
            "kind": "r",
            "persistence": "p"
        }
    }
] as const;
