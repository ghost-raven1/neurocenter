/** Migration 23 physical facts, measured on isolated PostgreSQL 16.15. */
export const PROJECT_CHAT_SCHEMA_CONTRACT = [
    {
        kind: 'column',
        id: 'project_chat_messages.author_email',
        definition: {
            type: 'text',
            default: null,
            notNull: false,
        },
    },
    {
        kind: 'column',
        id: 'project_chat_messages.author_name',
        definition: {
            type: 'text',
            default: null,
            notNull: false,
        },
    },
    {
        kind: 'column',
        id: 'project_chat_messages.author_role',
        definition: {
            type: 'text',
            default: null,
            notNull: false,
        },
    },
    {
        kind: 'column',
        id: 'project_chat_messages.content',
        definition: {
            type: 'text',
            default: "''::text",
            notNull: true,
        },
    },
    {
        kind: 'column',
        id: 'project_chat_messages.created_at',
        definition: {
            type: 'timestamp with time zone',
            default: 'now()',
            notNull: true,
        },
    },
    {
        kind: 'column',
        id: 'project_chat_messages.error',
        definition: {
            type: 'text',
            default: null,
            notNull: false,
        },
    },
    {
        kind: 'column',
        id: 'project_chat_messages.generation',
        definition: {
            type: 'uuid',
            default: null,
            notNull: true,
        },
    },
    {
        kind: 'column',
        id: 'project_chat_messages.id',
        definition: {
            type: 'uuid',
            default: null,
            notNull: true,
        },
    },
    {
        kind: 'column',
        id: 'project_chat_messages.kind',
        definition: {
            type: 'text',
            default: null,
            notNull: true,
        },
    },
    {
        kind: 'column',
        id: 'project_chat_messages.lease_until',
        definition: {
            type: 'timestamp with time zone',
            default: null,
            notNull: false,
        },
    },
    {
        kind: 'column',
        id: 'project_chat_messages.position',
        definition: {
            type: 'bigint',
            default: null,
            notNull: true,
        },
    },
    {
        kind: 'column',
        id: 'project_chat_messages.project_id',
        definition: {
            type: 'text',
            default: null,
            notNull: true,
        },
    },
    {
        kind: 'column',
        id: 'project_chat_messages.reply_to_id',
        definition: {
            type: 'uuid',
            default: null,
            notNull: false,
        },
    },
    {
        kind: 'column',
        id: 'project_chat_messages.request_hash',
        definition: {
            type: 'text',
            default: null,
            notNull: false,
        },
    },
    {
        kind: 'column',
        id: 'project_chat_messages.request_key',
        definition: {
            type: 'uuid',
            default: null,
            notNull: false,
        },
    },
    {
        kind: 'column',
        id: 'project_chat_messages.snapshot',
        definition: {
            type: 'jsonb',
            default: null,
            notNull: false,
        },
    },
    {
        kind: 'column',
        id: 'project_chat_messages.source_message_id',
        definition: {
            type: 'uuid',
            default: null,
            notNull: false,
        },
    },
    {
        kind: 'column',
        id: 'project_chat_messages.status',
        definition: {
            type: 'text',
            default: null,
            notNull: true,
        },
    },
    {
        kind: 'column',
        id: 'project_chat_messages.target_agent_ids',
        definition: {
            type: 'text[]',
            default: "'{}'::text[]",
            notNull: true,
        },
    },
    {
        kind: 'column',
        id: 'project_chat_messages.usage',
        definition: {
            type: 'jsonb',
            default: null,
            notNull: false,
        },
    },
    {
        kind: 'column',
        id: 'project_chat_retry_requests.actor_email',
        definition: {
            type: 'text',
            default: null,
            notNull: true,
        },
    },
    {
        kind: 'column',
        id: 'project_chat_retry_requests.created_at',
        definition: {
            type: 'timestamp with time zone',
            default: 'now()',
            notNull: true,
        },
    },
    {
        kind: 'column',
        id: 'project_chat_retry_requests.message_id',
        definition: {
            type: 'uuid',
            default: null,
            notNull: true,
        },
    },
    {
        kind: 'column',
        id: 'project_chat_retry_requests.project_id',
        definition: {
            type: 'text',
            default: null,
            notNull: true,
        },
    },
    {
        kind: 'column',
        id: 'project_chat_retry_requests.request_key',
        definition: {
            type: 'uuid',
            default: null,
            notNull: true,
        },
    },
    {
        kind: 'column',
        id: 'project_chat_rooms.agent_ids',
        definition: {
            type: 'text[]',
            default: "'{}'::text[]",
            notNull: true,
        },
    },
    {
        kind: 'column',
        id: 'project_chat_rooms.model_id',
        definition: {
            type: 'text',
            default: null,
            notNull: false,
        },
    },
    {
        kind: 'column',
        id: 'project_chat_rooms.model_pin',
        definition: {
            type: 'text',
            default: null,
            notNull: false,
        },
    },
    {
        kind: 'column',
        id: 'project_chat_rooms.project_id',
        definition: {
            type: 'text',
            default: null,
            notNull: true,
        },
    },
    {
        kind: 'column',
        id: 'project_chat_rooms.revision',
        definition: {
            type: 'bigint',
            default: '1',
            notNull: true,
        },
    },
    {
        kind: 'column',
        id: 'project_chat_rooms.updated_at',
        definition: {
            type: 'timestamp with time zone',
            default: 'now()',
            notNull: true,
        },
    },
    {
        kind: 'constraint',
        id: 'project_chat_messages.project_chat_messages_check',
        definition: {
            type: 'c',
            validated: true,
            definition:
                "CHECK (kind = 'user'::text AND author_email IS NOT NULL AND author_name IS NOT NULL AND author_role IS NOT NULL AND request_key IS NOT NULL AND request_hash IS NOT NULL AND source_message_id IS NULL AND snapshot IS NULL AND octet_length(content) >= 1 AND octet_length(content) <= 131072 OR (kind = ANY (ARRAY['agent'::text, 'summary'::text])) AND author_email IS NULL AND author_name IS NULL AND author_role IS NULL AND request_key IS NULL AND request_hash IS NULL AND source_message_id IS NOT NULL AND (kind = 'agent'::text) = (snapshot IS NOT NULL))",
        },
    },
    {
        kind: 'constraint',
        id: 'project_chat_messages.project_chat_messages_check1',
        definition: {
            type: 'c',
            validated: true,
            definition: "CHECK ((status = 'running'::text) = (lease_until IS NOT NULL))",
        },
    },
    {
        kind: 'constraint',
        id: 'project_chat_messages.project_chat_messages_check2',
        definition: {
            type: 'c',
            validated: true,
            definition: "CHECK (kind <> 'agent'::text OR status <> 'done'::text OR length(content) > 0)",
        },
    },
    {
        kind: 'constraint',
        id: 'project_chat_messages.project_chat_messages_content_check',
        definition: {
            type: 'c',
            validated: true,
            definition: 'CHECK (octet_length(content) <= 8388608)',
        },
    },
    {
        kind: 'constraint',
        id: 'project_chat_messages.project_chat_messages_kind_check',
        definition: {
            type: 'c',
            validated: true,
            definition: "CHECK (kind = ANY (ARRAY['user'::text, 'agent'::text, 'summary'::text]))",
        },
    },
    {
        kind: 'constraint',
        id: 'project_chat_messages.project_chat_messages_pkey',
        definition: {
            type: 'p',
            validated: true,
            definition: 'PRIMARY KEY (id)',
        },
    },
    {
        kind: 'constraint',
        id: 'project_chat_messages.project_chat_messages_project_id_author_email_request_key_key',
        definition: {
            type: 'u',
            validated: true,
            definition: 'UNIQUE (project_id, author_email, request_key)',
        },
    },
    {
        kind: 'constraint',
        id: 'project_chat_messages.project_chat_messages_project_id_fkey',
        definition: {
            type: 'f',
            validated: true,
            definition: 'FOREIGN KEY (project_id) REFERENCES project_chat_rooms(project_id) ON DELETE CASCADE',
        },
    },
    {
        kind: 'constraint',
        id: 'project_chat_messages.project_chat_messages_project_id_id_key',
        definition: {
            type: 'u',
            validated: true,
            definition: 'UNIQUE (project_id, id)',
        },
    },
    {
        kind: 'constraint',
        id: 'project_chat_messages.project_chat_messages_project_id_reply_to_id_fkey',
        definition: {
            type: 'f',
            validated: true,
            definition: 'FOREIGN KEY (project_id, reply_to_id) REFERENCES project_chat_messages(project_id, id)',
        },
    },
    {
        kind: 'constraint',
        id: 'project_chat_messages.project_chat_messages_project_id_source_message_id_fkey',
        definition: {
            type: 'f',
            validated: true,
            definition: 'FOREIGN KEY (project_id, source_message_id) REFERENCES project_chat_messages(project_id, id)',
        },
    },
    {
        kind: 'constraint',
        id: 'project_chat_messages.project_chat_messages_request_hash_check',
        definition: {
            type: 'c',
            validated: true,
            definition: "CHECK (request_hash ~ '^[a-f0-9]{64}$'::text)",
        },
    },
    {
        kind: 'constraint',
        id: 'project_chat_messages.project_chat_messages_snapshot_check',
        definition: {
            type: 'c',
            validated: true,
            definition:
                "CHECK (snapshot IS NULL OR jsonb_typeof(snapshot) = 'object'::text AND octet_length(snapshot::text) <= 262144)",
        },
    },
    {
        kind: 'constraint',
        id: 'project_chat_messages.project_chat_messages_status_check',
        definition: {
            type: 'c',
            validated: true,
            definition:
                "CHECK (status = ANY (ARRAY['queued'::text, 'running'::text, 'done'::text, 'failed'::text, 'cancelled'::text]))",
        },
    },
    {
        kind: 'constraint',
        id: 'project_chat_messages.project_chat_messages_target_agent_ids_check',
        definition: {
            type: 'c',
            validated: true,
            definition: 'CHECK (cardinality(target_agent_ids) <= 8)',
        },
    },
    {
        kind: 'constraint',
        id: 'project_chat_retry_requests.project_chat_retry_requests_pkey',
        definition: {
            type: 'p',
            validated: true,
            definition: 'PRIMARY KEY (project_id, actor_email, request_key)',
        },
    },
    {
        kind: 'constraint',
        id: 'project_chat_retry_requests.project_chat_retry_requests_project_id_fkey',
        definition: {
            type: 'f',
            validated: true,
            definition: 'FOREIGN KEY (project_id) REFERENCES project_chat_rooms(project_id) ON DELETE CASCADE',
        },
    },
    {
        kind: 'constraint',
        id: 'project_chat_retry_requests.project_chat_retry_requests_project_id_message_id_fkey',
        definition: {
            type: 'f',
            validated: true,
            definition: 'FOREIGN KEY (project_id, message_id) REFERENCES project_chat_messages(project_id, id)',
        },
    },
    {
        kind: 'constraint',
        id: 'project_chat_rooms.project_chat_rooms_agent_ids_check',
        definition: {
            type: 'c',
            validated: true,
            definition: 'CHECK (cardinality(agent_ids) <= 8)',
        },
    },
    {
        kind: 'constraint',
        id: 'project_chat_rooms.project_chat_rooms_check',
        definition: {
            type: 'c',
            validated: true,
            definition: 'CHECK ((model_id IS NULL) = (model_pin IS NULL))',
        },
    },
    {
        kind: 'constraint',
        id: 'project_chat_rooms.project_chat_rooms_check1',
        definition: {
            type: 'c',
            validated: true,
            definition: 'CHECK (cardinality(agent_ids) = 0 OR model_id IS NOT NULL)',
        },
    },
    {
        kind: 'constraint',
        id: 'project_chat_rooms.project_chat_rooms_model_pin_check',
        definition: {
            type: 'c',
            validated: true,
            definition: "CHECK (model_pin ~ '^[a-f0-9]{64}$'::text)",
        },
    },
    {
        kind: 'constraint',
        id: 'project_chat_rooms.project_chat_rooms_pkey',
        definition: {
            type: 'p',
            validated: true,
            definition: 'PRIMARY KEY (project_id)',
        },
    },
    {
        kind: 'constraint',
        id: 'project_chat_rooms.project_chat_rooms_project_id_fkey',
        definition: {
            type: 'f',
            validated: true,
            definition: 'FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE',
        },
    },
    {
        kind: 'constraint',
        id: 'project_chat_rooms.project_chat_rooms_revision_check',
        definition: {
            type: 'c',
            validated: true,
            definition: 'CHECK (revision > 0)',
        },
    },
    {
        kind: 'function',
        id: 'neurocenter_project_chat_message_immutable()',
        definition: {
            definitionMd5: '4ac106556858b96e661f35345305178e',
        },
    },
    {
        kind: 'index',
        id: 'project_chat_agent_slot',
        definition: {
            ready: true,
            valid: true,
            definition:
                "CREATE UNIQUE INDEX project_chat_agent_slot ON project_chat_messages USING btree (source_message_id, ((snapshot ->> 'agentId'::text))) WHERE (kind = 'agent'::text)",
        },
    },
    {
        kind: 'index',
        id: 'project_chat_history',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE INDEX project_chat_history ON project_chat_messages USING btree (project_id, "position" DESC)',
        },
    },
    {
        kind: 'index',
        id: 'project_chat_messages_pkey',
        definition: {
            ready: true,
            valid: true,
            definition: 'CREATE UNIQUE INDEX project_chat_messages_pkey ON project_chat_messages USING btree (id)',
        },
    },
    {
        kind: 'index',
        id: 'project_chat_messages_project_id_author_email_request_key_key',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE UNIQUE INDEX project_chat_messages_project_id_author_email_request_key_key ON project_chat_messages USING btree (project_id, author_email, request_key)',
        },
    },
    {
        kind: 'index',
        id: 'project_chat_messages_project_id_id_key',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE UNIQUE INDEX project_chat_messages_project_id_id_key ON project_chat_messages USING btree (project_id, id)',
        },
    },
    {
        kind: 'index',
        id: 'project_chat_queue',
        definition: {
            ready: true,
            valid: true,
            definition:
                "CREATE INDEX project_chat_queue ON project_chat_messages USING btree (project_id, \"position\") WHERE ((kind = 'user'::text) AND (status = 'queued'::text))",
        },
    },
    {
        kind: 'index',
        id: 'project_chat_retry_requests_pkey',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE UNIQUE INDEX project_chat_retry_requests_pkey ON project_chat_retry_requests USING btree (project_id, actor_email, request_key)',
        },
    },
    {
        kind: 'index',
        id: 'project_chat_rooms_pkey',
        definition: {
            ready: true,
            valid: true,
            definition: 'CREATE UNIQUE INDEX project_chat_rooms_pkey ON project_chat_rooms USING btree (project_id)',
        },
    },
    {
        kind: 'index',
        id: 'project_chat_single_running',
        definition: {
            ready: true,
            valid: true,
            definition:
                "CREATE UNIQUE INDEX project_chat_single_running ON project_chat_messages USING btree (project_id) WHERE ((kind = 'user'::text) AND (status = 'running'::text))",
        },
    },
    {
        kind: 'index',
        id: 'project_chat_summary_slot',
        definition: {
            ready: true,
            valid: true,
            definition:
                "CREATE UNIQUE INDEX project_chat_summary_slot ON project_chat_messages USING btree (source_message_id) WHERE (kind = 'summary'::text)",
        },
    },
    {
        kind: 'table',
        id: 'project_chat_messages',
        definition: {
            kind: 'r',
            persistence: 'p',
        },
    },
    {
        kind: 'table',
        id: 'project_chat_retry_requests',
        definition: {
            kind: 'r',
            persistence: 'p',
        },
    },
    {
        kind: 'table',
        id: 'project_chat_rooms',
        definition: {
            kind: 'r',
            persistence: 'p',
        },
    },
    {
        kind: 'trigger',
        id: 'project_chat_messages.project_chat_message_immutable',
        definition: {
            enabled: 'O',
            definition:
                'CREATE TRIGGER project_chat_message_immutable BEFORE UPDATE ON project_chat_messages FOR EACH ROW EXECUTE FUNCTION neurocenter_project_chat_message_immutable()',
        },
    },
] as const;
