/** Миграция меняет ограничение типа вектора, сохраняя значения; старого runtime пути после неё нет. */
export const RAG_GENERATION_SCHEMA = `
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS rag_chunks (
    id TEXT NOT NULL,project_key TEXT NOT NULL,generation_id TEXT NOT NULL,
    file_path TEXT NOT NULL DEFAULT '',content TEXT NOT NULL,description TEXT,start_line INTEGER,end_line INTEGER,
    language TEXT,kind TEXT NOT NULL DEFAULT '',role TEXT,quirk_type TEXT,tags TEXT,content_hash TEXT NOT NULL,
    embedding vector,sync_hash TEXT,updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY(id,project_key,generation_id)
);
LOCK TABLE rag_chunks IN ACCESS EXCLUSIVE MODE;
DROP INDEX IF EXISTS rag_chunks_emb_hnsw;
DROP INDEX IF EXISTS rag_chunks_emb_ivfflat;
ALTER TABLE rag_chunks ADD COLUMN IF NOT EXISTS generation_id TEXT;
ALTER TABLE rag_chunks ADD COLUMN IF NOT EXISTS sync_hash TEXT;
UPDATE rag_chunks SET generation_id='initial-'||md5(project_key) WHERE generation_id IS NULL;
ALTER TABLE rag_chunks ALTER COLUMN generation_id SET NOT NULL;
ALTER TABLE rag_chunks ALTER COLUMN embedding TYPE vector USING embedding::vector;
DO $$ BEGIN
    IF EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='rag_chunks'::regclass AND contype='p'
        AND pg_get_constraintdef(oid) NOT LIKE '%generation_id%') THEN
        ALTER TABLE rag_chunks DROP CONSTRAINT rag_chunks_pkey;
        ALTER TABLE rag_chunks ADD PRIMARY KEY(id,project_key,generation_id);
    END IF;
END $$;
CREATE INDEX IF NOT EXISTS rag_chunks_generation_idx ON rag_chunks(project_key,generation_id,id);
CREATE INDEX IF NOT EXISTS rag_chunks_hash_idx ON rag_chunks(project_key,content_hash);
CREATE TABLE IF NOT EXISTS rag_index_state (
    project_key TEXT NOT NULL,generation_id TEXT NOT NULL,index_profile JSONB,
    complete BOOLEAN NOT NULL DEFAULT false,snapshot_hash TEXT,snapshot_rows BIGINT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),PRIMARY KEY(project_key,generation_id)
);
ALTER TABLE rag_index_state ADD COLUMN IF NOT EXISTS generation_id TEXT;
UPDATE rag_index_state SET generation_id='initial-'||md5(project_key) WHERE generation_id IS NULL;
ALTER TABLE rag_index_state ALTER COLUMN generation_id SET NOT NULL;
DO $$ BEGIN
    IF EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='rag_index_state'::regclass AND contype='p'
        AND pg_get_constraintdef(oid) NOT LIKE '%generation_id%') THEN
        ALTER TABLE rag_index_state DROP CONSTRAINT rag_index_state_pkey;
        ALTER TABLE rag_index_state ADD PRIMARY KEY(project_key,generation_id);
    END IF;
END $$;
CREATE TABLE IF NOT EXISTS rag_generations (
    id TEXT PRIMARY KEY,project_key TEXT NOT NULL,index_profile JSONB,
    state TEXT NOT NULL CHECK(state IN ('building','ready','cancelled','failed')),
    source_generation TEXT,source_snapshot TEXT,source_rows BIGINT NOT NULL DEFAULT 0,
    snapshot_hash TEXT,receipt_hash TEXT,processed_rows BIGINT NOT NULL DEFAULT 0,
    error TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO rag_generations(id,project_key,index_profile,state)
    SELECT DISTINCT c.generation_id,c.project_key,s.index_profile,'ready' FROM rag_chunks c
    LEFT JOIN rag_index_state s ON s.project_key=c.project_key AND s.generation_id=c.generation_id
    ON CONFLICT(id) DO NOTHING;
CREATE TABLE IF NOT EXISTS rag_write_receipts (
    id UUID PRIMARY KEY,project_key TEXT NOT NULL,generation_id TEXT NOT NULL,payload_hash TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('running','succeeded','failed')),result JSONB,error JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION neurocenter_rag_vector_dimension() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE dimension INTEGER;
BEGIN
    SELECT (index_profile->>'dimension')::integer INTO dimension FROM rag_index_state
        WHERE project_key=NEW.project_key AND generation_id=NEW.generation_id;
    IF NEW.embedding IS NOT NULL AND dimension IS NOT NULL AND vector_dims(NEW.embedding)<>dimension THEN
        RAISE EXCEPTION 'Вектор не соответствует размерности поколения' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS rag_vector_dimension ON rag_chunks;
CREATE TRIGGER rag_vector_dimension BEFORE INSERT OR UPDATE ON rag_chunks FOR EACH ROW EXECUTE FUNCTION neurocenter_rag_vector_dimension();
`;
