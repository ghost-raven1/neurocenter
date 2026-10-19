/** Версия SQL неизменяема после выпуска; следующие изменения получают отдельную миграцию. */
export const RAG_QUOTA_MIGRATION='001-rag-storage-budget';
export const RAG_WRITE_LOCK=72465385;

const texts=['id','project_key','file_path','content','description','language','kind','role','quirk_type','tags','content_hash'];
const textBytes=texts.map(field=>`COALESCE(octet_length((value).${field}),0)::bigint`).join(' + ');

export const RAG_QUOTA_SCHEMA=`
CREATE TABLE public.rag_storage_settings (
    singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
    default_bytes bigint NOT NULL CHECK(default_bytes>0),
    maximum_bytes bigint NOT NULL CHECK(maximum_bytes>=default_bytes)
);
CREATE TABLE public.rag_storage_budget (
    project_key text PRIMARY KEY,
    used_bytes bigint NOT NULL DEFAULT 0 CHECK(used_bytes>=0),
    limit_bytes bigint NOT NULL CHECK(limit_bytes>0),
    revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0)
);
CREATE TABLE public.rag_quota_events (
    id bigserial PRIMARY KEY,project_key text NOT NULL,actor text NOT NULL,
    before_bytes bigint,after_bytes bigint NOT NULL,revision bigint NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION public.neurocenter_rag_row_bytes(value public.rag_chunks) RETURNS bigint
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog,public AS $$
    SELECT ${textBytes}
        + CASE WHEN (value).start_line IS NULL THEN 0 ELSE 4 END
        + CASE WHEN (value).end_line IS NULL THEN 0 ELSE 4 END
        + CASE WHEN (value).embedding IS NULL THEN 0 ELSE 8+4*public.vector_dims((value).embedding) END;
$$;
CREATE FUNCTION public.neurocenter_rag_write_lock() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN PERFORM pg_advisory_xact_lock(${RAG_WRITE_LOCK}); RETURN NULL; END;
$$;
CREATE TRIGGER rag_budget_write_lock BEFORE INSERT OR UPDATE OR DELETE ON public.rag_storage_budget
FOR EACH STATEMENT EXECUTE FUNCTION public.neurocenter_rag_write_lock();
CREATE TRIGGER rag_chunks_write_lock BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON public.rag_chunks
FOR EACH STATEMENT EXECUTE FUNCTION public.neurocenter_rag_write_lock();
CREATE FUNCTION public.neurocenter_ensure_rag_budget(key text) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE bytes bigint; default_limit bigint;
BEGIN
    IF EXISTS(SELECT 1 FROM public.rag_storage_budget WHERE project_key=key) THEN RETURN; END IF;
    SELECT default_bytes INTO STRICT default_limit FROM public.rag_storage_settings WHERE singleton;
    SELECT COALESCE(sum(public.neurocenter_rag_row_bytes(c)),0) INTO bytes FROM public.rag_chunks c WHERE project_key=key;
    INSERT INTO public.rag_storage_budget(project_key,used_bytes,limit_bytes)
        VALUES(key,bytes,GREATEST(default_limit,bytes)) ON CONFLICT DO NOTHING;
END;
$$;
CREATE FUNCTION public.neurocenter_rag_budget_before() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
    IF TG_OP<>'INSERT' THEN PERFORM public.neurocenter_ensure_rag_budget(OLD.project_key); END IF;
    IF TG_OP<>'DELETE' THEN PERFORM public.neurocenter_ensure_rag_budget(NEW.project_key); RETURN NEW; END IF;
    RETURN OLD;
END;
$$;
CREATE TRIGGER rag_chunks_budget_before BEFORE INSERT OR UPDATE OR DELETE ON public.rag_chunks
FOR EACH ROW EXECUTE FUNCTION public.neurocenter_rag_budget_before();
CREATE FUNCTION public.neurocenter_rag_budget_after() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
    IF TG_OP='UPDATE' THEN
        IF OLD.project_key=NEW.project_key THEN
            UPDATE public.rag_storage_budget SET used_bytes=used_bytes+public.neurocenter_rag_row_bytes(NEW)-public.neurocenter_rag_row_bytes(OLD) WHERE project_key=NEW.project_key;
            RETURN NULL;
        END IF;
    END IF;
    IF TG_OP<>'INSERT' THEN UPDATE public.rag_storage_budget SET used_bytes=used_bytes-public.neurocenter_rag_row_bytes(OLD) WHERE project_key=OLD.project_key; END IF;
    IF TG_OP<>'DELETE' THEN UPDATE public.rag_storage_budget SET used_bytes=used_bytes+public.neurocenter_rag_row_bytes(NEW) WHERE project_key=NEW.project_key; END IF;
    RETURN NULL;
END;
$$;
CREATE TRIGGER rag_chunks_budget_after AFTER INSERT OR UPDATE OR DELETE ON public.rag_chunks
FOR EACH ROW EXECUTE FUNCTION public.neurocenter_rag_budget_after();
CREATE FUNCTION public.neurocenter_rag_budget_truncate() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN UPDATE public.rag_storage_budget SET used_bytes=0; RETURN NULL; END;
$$;
CREATE TRIGGER rag_chunks_budget_truncate AFTER TRUNCATE ON public.rag_chunks
FOR EACH STATEMENT EXECUTE FUNCTION public.neurocenter_rag_budget_truncate();
CREATE FUNCTION public.neurocenter_check_rag_budget() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE used bigint; maximum bigint;
BEGIN
    SELECT used_bytes,limit_bytes INTO used,maximum FROM public.rag_storage_budget WHERE project_key=NEW.project_key;
    IF FOUND AND used>maximum THEN
        RAISE EXCEPTION USING ERRCODE='23514',CONSTRAINT='rag_storage_quota_limit',
            MESSAGE='Превышен лимит базы знаний',DETAIL=json_build_object('attemptedBytes',used,'limitBytes',maximum)::text;
    END IF;
    RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER rag_storage_quota_limit AFTER INSERT OR UPDATE ON public.rag_storage_budget
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.neurocenter_check_rag_budget();
CREATE FUNCTION public.neurocenter_audit_rag_budget() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE previous bigint;who text;
BEGIN
    IF TG_OP='UPDATE' THEN
        IF OLD.limit_bytes=NEW.limit_bytes THEN RETURN NULL; END IF;
        previous=OLD.limit_bytes;
    END IF;
    who=COALESCE(NULLIF(current_setting('neurocenter.rag_actor',true),''),'database:'||current_user);
    INSERT INTO public.rag_quota_events(project_key,actor,before_bytes,after_bytes,revision)
        VALUES(NEW.project_key,who,previous,NEW.limit_bytes,NEW.revision);
    RETURN NULL;
END;
$$;
CREATE TRIGGER rag_budget_audit AFTER INSERT OR UPDATE OF limit_bytes ON public.rag_storage_budget
FOR EACH ROW EXECUTE FUNCTION public.neurocenter_audit_rag_budget();
`;
