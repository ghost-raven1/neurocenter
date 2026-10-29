import {RAG_WRITE_LOCK} from '../rag/quota/rag-quota-schema';

/** Separate text storage shares the existing deferred project budget, without changing semantic rows. */
export const PROJECT_TEXT_SCHEMA=`
CREATE TABLE public.project_text_state (
    project_key text PRIMARY KEY,
    revision bigint NOT NULL CHECK(revision>0),
    corpus_hash text NOT NULL CHECK(corpus_hash ~ '^[a-f0-9]{64}$'),
    document_count integer NOT NULL CHECK(document_count>=0),
    bytes bigint NOT NULL CHECK(bytes>=0),
    updated_at timestamptz NOT NULL
);
CREATE TABLE public.project_text_documents (
    project_key text NOT NULL,
    path text NOT NULL CHECK(octet_length(path) BETWEEN 1 AND 512),
    id text NOT NULL CHECK(id ~ '^[a-f0-9]{64}$'),
    content text NOT NULL CHECK(octet_length(content)<=131072),
    content_hash text NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'),
    bytes integer NOT NULL CHECK(bytes=octet_length(content)+octet_length(path)),
    search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig,path||E'\n'||content)) STORED,
    PRIMARY KEY(project_key,path),UNIQUE(project_key,id)
);
CREATE INDEX project_text_search_idx ON public.project_text_documents USING gin(search_vector);
CREATE TABLE public.project_text_receipts (
    project_key text NOT NULL,
    actor_email text NOT NULL,
    request_key uuid NOT NULL,
    request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
    result jsonb NOT NULL CHECK(jsonb_typeof(result)='object'),
    accepted_at timestamptz NOT NULL,
    PRIMARY KEY(project_key,actor_email,request_key)
);
CREATE FUNCTION public.neurocenter_text_row_bytes(value jsonb) RETURNS bigint
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog,public AS $$
    SELECT octet_length((value-'search_vector')::text)::bigint;
$$;
CREATE FUNCTION public.neurocenter_text_budget_before() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
    IF TG_OP<>'INSERT' THEN PERFORM public.neurocenter_ensure_rag_budget(OLD.project_key); END IF;
    IF TG_OP<>'DELETE' THEN PERFORM public.neurocenter_ensure_rag_budget(NEW.project_key); RETURN NEW; END IF;
    RETURN OLD;
END;
$$;
CREATE FUNCTION public.neurocenter_text_budget_after() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
    IF TG_OP='UPDATE' AND OLD.project_key=NEW.project_key THEN
        UPDATE public.rag_storage_budget SET used_bytes=used_bytes+public.neurocenter_text_row_bytes(to_jsonb(NEW))-public.neurocenter_text_row_bytes(to_jsonb(OLD)) WHERE project_key=NEW.project_key;
        RETURN NULL;
    END IF;
    IF TG_OP<>'INSERT' THEN UPDATE public.rag_storage_budget SET used_bytes=used_bytes-public.neurocenter_text_row_bytes(to_jsonb(OLD)) WHERE project_key=OLD.project_key; END IF;
    IF TG_OP<>'DELETE' THEN UPDATE public.rag_storage_budget SET used_bytes=used_bytes+public.neurocenter_text_row_bytes(to_jsonb(NEW)) WHERE project_key=NEW.project_key; END IF;
    RETURN NULL;
END;
$$;
CREATE FUNCTION public.neurocenter_text_budget_recount() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
    UPDATE public.rag_storage_budget b SET used_bytes=
        COALESCE((SELECT sum(public.neurocenter_rag_row_bytes(c)) FROM public.rag_chunks c WHERE c.project_key=b.project_key),0)+
        COALESCE((SELECT sum(public.neurocenter_text_row_bytes(to_jsonb(d))) FROM public.project_text_documents d WHERE d.project_key=b.project_key),0)+
        COALESCE((SELECT sum(public.neurocenter_text_row_bytes(to_jsonb(s))) FROM public.project_text_state s WHERE s.project_key=b.project_key),0)+
        COALESCE((SELECT sum(public.neurocenter_text_row_bytes(to_jsonb(r))) FROM public.project_text_receipts r WHERE r.project_key=b.project_key),0);
    RETURN NULL;
END;
$$;
${['project_text_state','project_text_documents','project_text_receipts'].map(table=>`
CREATE TRIGGER ${table}_write_lock BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON public.${table}
FOR EACH STATEMENT EXECUTE FUNCTION public.neurocenter_rag_write_lock();
CREATE TRIGGER ${table}_budget_before BEFORE INSERT OR UPDATE OR DELETE ON public.${table}
FOR EACH ROW EXECUTE FUNCTION public.neurocenter_text_budget_before();
CREATE TRIGGER ${table}_budget_after AFTER INSERT OR UPDATE OR DELETE ON public.${table}
FOR EACH ROW EXECUTE FUNCTION public.neurocenter_text_budget_after();
CREATE TRIGGER ${table}_budget_truncate AFTER TRUNCATE ON public.${table}
FOR EACH STATEMENT EXECUTE FUNCTION public.neurocenter_text_budget_recount();
`).join('')}
CREATE TRIGGER rag_text_chunks_budget_restore AFTER TRUNCATE ON public.rag_chunks
FOR EACH STATEMENT EXECUTE FUNCTION public.neurocenter_text_budget_recount();
`;

export const PROJECT_TEXT_OBJECTS={
    tables:['project_text_state','project_text_documents','project_text_receipts'],
    indexes:['project_text_search_idx'],
    functions:['neurocenter_text_row_bytes','neurocenter_text_budget_before','neurocenter_text_budget_after','neurocenter_text_budget_recount'],
    triggers:[...['project_text_state','project_text_documents','project_text_receipts'].flatMap(table=>
        ['write_lock','budget_before','budget_after','budget_truncate'].map(suffix=>`${table}_${suffix}`)),'rag_text_chunks_budget_restore'],
};

/** All text mutations acquire the very same statement lock as semantic writes and quota changes. */
export const PROJECT_TEXT_WRITE_LOCK=RAG_WRITE_LOCK;
