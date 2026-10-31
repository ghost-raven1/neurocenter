/** The body is also checked verbatim by readiness; no profile/grant payload can widen silently. */
export const BROWSER_AUTH_SESSION_GUARD_BODY = `
DECLARE field text; bound integer;
BEGIN
 IF NEW.token_hash !~ '^[a-f0-9]{64}$' OR jsonb_typeof(NEW.identity) IS DISTINCT FROM 'object'
 THEN RAISE EXCEPTION 'Invalid browser session identity'; END IF;
 IF NEW.identity-ARRAY['id','principalName','email','displayName']<>'{}'::jsonb OR octet_length(NEW.identity::text)>8192
 THEN RAISE EXCEPTION 'Invalid browser session identity'; END IF;
 FOR field,bound IN SELECT * FROM (VALUES('id',512),('principalName',512),('email',320),('displayName',512)) limits(field,bound) LOOP
  IF jsonb_typeof(NEW.identity->field) IS DISTINCT FROM 'string' OR length(btrim(NEW.identity->>field))=0
   OR length(NEW.identity->>field)>bound OR (NEW.identity->>field)~'[[:cntrl:]]'
  THEN RAISE EXCEPTION 'Invalid browser session identity'; END IF;
 END LOOP;
 IF (NEW.identity->>'email') !~ '^[^[:space:]@]+@[^[:space:]@]+$' OR length(btrim(NEW.selected_role))=0
  OR length(NEW.selected_role)>128 OR NEW.selected_role~'[[:cntrl:]]'
  OR NOT isfinite(NEW.created_at) OR NOT isfinite(NEW.expires_at)
  OR NEW.expires_at-NEW.created_at<interval '60 seconds' OR NEW.expires_at-NEW.created_at>interval '86400 seconds'
 THEN RAISE EXCEPTION 'Invalid browser session lifetime or preference'; END IF;
 IF TG_OP='UPDATE' THEN
  IF (NEW.token_hash,NEW.identity,NEW.created_at,NEW.expires_at) IS DISTINCT FROM (OLD.token_hash,OLD.identity,OLD.created_at,OLD.expires_at)
   OR OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
   OR NEW.selected_role IS DISTINCT FROM OLD.selected_role AND (OLD.revoked_at IS NOT NULL OR OLD.expires_at<=clock_timestamp())
  THEN RAISE EXCEPTION 'Browser session cannot be renewed or resurrected'; END IF;
 END IF;
 RETURN NEW;
END;
`;

/** Migration38 is additive; existing sessions and all earlier migration checksums stay intact. */
export const BROWSER_AUTH_SESSION_SCHEMA_SQL = `
CREATE TABLE browser_auth_sessions (
 token_hash text PRIMARY KEY,identity jsonb NOT NULL,selected_role text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL,revoked_at timestamptz
);
CREATE INDEX browser_auth_sessions_expiry ON browser_auth_sessions(expires_at);
CREATE FUNCTION browser_auth_session_guard() RETURNS trigger LANGUAGE plpgsql AS $browser_session$${BROWSER_AUTH_SESSION_GUARD_BODY}$browser_session$;
CREATE TRIGGER browser_auth_session_guard BEFORE INSERT OR UPDATE ON browser_auth_sessions FOR EACH ROW EXECUTE FUNCTION browser_auth_session_guard();
`;
