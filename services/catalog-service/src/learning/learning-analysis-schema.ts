/** Analysis input is immutable; a lost worker cannot silently repeat a paid inference. */
export const LEARNING_ANALYSIS_SCHEMA_SQL=`
CREATE TABLE project_learning_analyses (
 id UUID PRIMARY KEY,project_id TEXT NOT NULL REFERENCES project_learning_state(project_id) ON DELETE CASCADE,
 actor_email TEXT NOT NULL,actor_role TEXT NOT NULL,request_key UUID NOT NULL,mutation_key UUID NOT NULL UNIQUE,
 request_hash TEXT NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 model_id TEXT NOT NULL,model_pin TEXT NOT NULL CHECK(model_pin ~ '^[a-f0-9]{64}$'),model_epoch UUID NOT NULL,
 source_revision BIGINT NOT NULL CHECK(source_revision>=0),input JSONB NOT NULL CHECK(jsonb_typeof(input)='object'),
 experiences JSONB NOT NULL CHECK(jsonb_typeof(experiences)='array'),
 state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','completed','failed','unknown')),
 hypothesis_ids JSONB NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(hypothesis_ids)='array'),
 error_code TEXT,error_message TEXT,worker_id UUID,lease_until TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),started_at TIMESTAMPTZ,finished_at TIMESTAMPTZ,
 UNIQUE(actor_email,request_key),CHECK((state='running')=(worker_id IS NOT NULL AND lease_until IS NOT NULL)),
 CHECK(state NOT IN ('completed','failed','unknown') OR finished_at IS NOT NULL),
 CHECK((state='completed')=(jsonb_array_length(hypothesis_ids)>0)));
CREATE UNIQUE INDEX project_learning_one_analysis ON project_learning_analyses(project_id) WHERE state IN ('queued','running');
CREATE INDEX project_learning_analysis_queue ON project_learning_analyses(created_at,id) WHERE state='queued';
CREATE FUNCTION neurocenter_learning_analysis_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN
  IF NOT EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Learning analysis provenance is immutable';
 END IF;
 IF OLD.state IN ('completed','failed','unknown') AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
  RAISE EXCEPTION 'A terminal learning analysis cannot restart'; END IF;
 IF NEW.state<>OLD.state AND NOT ((OLD.state='queued' AND NEW.state='running') OR (OLD.state='running' AND NEW.state IN ('completed','failed','unknown'))) THEN
  RAISE EXCEPTION 'Invalid learning analysis transition'; END IF;
 IF (NEW.id,NEW.project_id,NEW.actor_email,NEW.actor_role,NEW.request_key,NEW.mutation_key,NEW.request_hash,NEW.model_id,NEW.model_pin,NEW.model_epoch,NEW.source_revision,NEW.input,NEW.experiences,NEW.created_at)
 IS DISTINCT FROM (OLD.id,OLD.project_id,OLD.actor_email,OLD.actor_role,OLD.request_key,OLD.mutation_key,OLD.request_hash,OLD.model_id,OLD.model_pin,OLD.model_epoch,OLD.source_revision,OLD.input,OLD.experiences,OLD.created_at)
 THEN RAISE EXCEPTION 'Learning analysis provenance is immutable'; END IF;RETURN NEW;END $$;
CREATE TRIGGER neurocenter_learning_analysis_immutable BEFORE UPDATE OR DELETE ON project_learning_analyses FOR EACH ROW EXECUTE FUNCTION neurocenter_learning_analysis_immutable();
`;
