/** Migration 8 adds project-scoped evidence and reversible, explicitly approved context. */
export const LEARNING_SCHEMA_SQL=`
CREATE TABLE project_learning_state (
 project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
 revision BIGINT NOT NULL DEFAULT 0 CHECK(revision>=0),updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TRIGGER neurocenter_retired_reference_guard BEFORE INSERT OR UPDATE OF project_id ON project_learning_state
 FOR EACH ROW EXECUTE FUNCTION neurocenter_retired_reference_guard();
CREATE TABLE project_learning_experiences (
 id UUID PRIMARY KEY,project_id TEXT NOT NULL REFERENCES project_learning_state(project_id) ON DELETE CASCADE,
 data JSONB NOT NULL CHECK(jsonb_typeof(data)='object'),created_by TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),UNIQUE(project_id,id));
CREATE TABLE project_learning_hypotheses (
 id UUID PRIMARY KEY,project_id TEXT NOT NULL REFERENCES project_learning_state(project_id) ON DELETE CASCADE,
 data JSONB NOT NULL CHECK(jsonb_typeof(data)='object'),model JSONB CHECK(model IS NULL OR jsonb_typeof(model)='object'),
 status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','supported','refuted','inconclusive')),
 revision BIGINT NOT NULL CHECK(revision>0),created_by TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),UNIQUE(project_id,id));
CREATE TABLE project_learning_checks (
 id UUID PRIMARY KEY,project_id TEXT NOT NULL REFERENCES project_learning_state(project_id) ON DELETE CASCADE,hypothesis_id UUID NOT NULL,
 data JSONB NOT NULL CHECK(jsonb_typeof(data)='object'),revision BIGINT NOT NULL CHECK(revision>0),created_by TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(project_id,id,hypothesis_id),FOREIGN KEY(project_id,hypothesis_id) REFERENCES project_learning_hypotheses(project_id,id) ON DELETE CASCADE);
CREATE TABLE project_learning_candidates (
 id UUID PRIMARY KEY,project_id TEXT NOT NULL REFERENCES project_learning_state(project_id) ON DELETE CASCADE,hypothesis_id UUID NOT NULL,check_id UUID NOT NULL,
 key TEXT NOT NULL CHECK(key ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(key)<=64),version INTEGER NOT NULL CHECK(version>0),
 data JSONB NOT NULL CHECK(jsonb_typeof(data)='object'),status TEXT NOT NULL DEFAULT 'proposed' CHECK(status IN ('proposed','approved','rejected','revoked')),
 revision BIGINT NOT NULL CHECK(revision>0),created_by TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 approved_by TEXT,approved_at TIMESTAMPTZ,reason TEXT,
 UNIQUE(project_id,key,version),UNIQUE(project_id,key,id),
 FOREIGN KEY(project_id,hypothesis_id) REFERENCES project_learning_hypotheses(project_id,id) ON DELETE CASCADE,
 FOREIGN KEY(project_id,check_id,hypothesis_id) REFERENCES project_learning_checks(project_id,id,hypothesis_id) ON DELETE CASCADE,
 CHECK((approved_by IS NULL)=(approved_at IS NULL)),CHECK(status NOT IN ('approved','revoked') OR approved_at IS NOT NULL));
CREATE TABLE project_learning_heads (
 project_id TEXT NOT NULL REFERENCES project_learning_state(project_id) ON DELETE CASCADE,key TEXT NOT NULL,candidate_id UUID NOT NULL,
 PRIMARY KEY(project_id,key),FOREIGN KEY(project_id,key,candidate_id) REFERENCES project_learning_candidates(project_id,key,id) ON DELETE CASCADE);
CREATE TABLE project_learning_history (
 id UUID PRIMARY KEY,project_id TEXT NOT NULL REFERENCES project_learning_state(project_id) ON DELETE CASCADE,
 revision BIGINT NOT NULL CHECK(revision>0),action TEXT NOT NULL,resource_id UUID NOT NULL,actor TEXT NOT NULL,
 details JSONB NOT NULL CHECK(jsonb_typeof(details)='object'),created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE project_learning_requests (
 actor TEXT NOT NULL,request_key UUID NOT NULL,project_id TEXT NOT NULL REFERENCES project_learning_state(project_id) ON DELETE CASCADE,
 request_hash TEXT NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),result JSONB NOT NULL CHECK(jsonb_typeof(result)='object'),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),PRIMARY KEY(actor,request_key));
CREATE INDEX project_learning_experiences_project ON project_learning_experiences(project_id,created_at DESC,id);
CREATE INDEX project_learning_hypotheses_project ON project_learning_hypotheses(project_id,created_at DESC,id);
CREATE INDEX project_learning_checks_hypothesis ON project_learning_checks(project_id,hypothesis_id,created_at,id);
CREATE INDEX project_learning_candidates_project ON project_learning_candidates(project_id,created_at DESC,id);
CREATE INDEX project_learning_history_project ON project_learning_history(project_id,revision DESC,id);
CREATE FUNCTION neurocenter_learning_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF NOT EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Learning evidence and provenance are immutable';
 END IF;
 IF (CASE WHEN TG_TABLE_NAME IN ('project_learning_hypotheses','project_learning_candidates') THEN to_jsonb(NEW)-ARRAY['status','revision','approved_by','approved_at','reason'] ELSE to_jsonb(NEW) END) IS DISTINCT FROM
    (CASE WHEN TG_TABLE_NAME IN ('project_learning_hypotheses','project_learning_candidates') THEN to_jsonb(OLD)-ARRAY['status','revision','approved_by','approved_at','reason'] ELSE to_jsonb(OLD) END) THEN
  RAISE EXCEPTION 'Learning evidence and provenance are immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER neurocenter_learning_immutable BEFORE UPDATE OR DELETE ON project_learning_experiences FOR EACH ROW EXECUTE FUNCTION neurocenter_learning_immutable();
CREATE TRIGGER neurocenter_learning_immutable BEFORE UPDATE OR DELETE ON project_learning_hypotheses FOR EACH ROW EXECUTE FUNCTION neurocenter_learning_immutable();
CREATE TRIGGER neurocenter_learning_immutable BEFORE UPDATE OR DELETE ON project_learning_checks FOR EACH ROW EXECUTE FUNCTION neurocenter_learning_immutable();
CREATE TRIGGER neurocenter_learning_immutable BEFORE UPDATE OR DELETE ON project_learning_candidates FOR EACH ROW EXECUTE FUNCTION neurocenter_learning_immutable();
CREATE TRIGGER neurocenter_learning_immutable BEFORE UPDATE OR DELETE ON project_learning_history FOR EACH ROW EXECUTE FUNCTION neurocenter_learning_immutable();
CREATE TRIGGER neurocenter_learning_immutable BEFORE UPDATE OR DELETE ON project_learning_requests FOR EACH ROW EXECUTE FUNCTION neurocenter_learning_immutable();
`;
