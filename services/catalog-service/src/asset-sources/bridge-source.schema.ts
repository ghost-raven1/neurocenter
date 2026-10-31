/** Migration 9: source selection and verified metadata are independent of the installed bridge head. */
export const BRIDGE_SOURCE_SCHEMA_SQL = `
CREATE TABLE bridge_source_settings (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),url text NOT NULL,revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 checked_at timestamptz,attempted_at timestamptz,check_token uuid,check_commit text,error text,
 installed_repository text,installed_asset_id text,updated_by text,updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK((installed_repository IS NULL)=(installed_asset_id IS NULL)));
INSERT INTO bridge_source_settings(singleton,url) VALUES(true,'https://github.com/ghost-raven1/neurocenter-assets');
CREATE TABLE bridge_source_checks (
 repository text NOT NULL,commit text NOT NULL CHECK(commit ~ '^[a-f0-9]{40}$'),
 pin jsonb NOT NULL,index jsonb NOT NULL,assets jsonb NOT NULL,checked_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(repository,commit));
ALTER TABLE asset_source_jobs ADD COLUMN bridge_source_revision integer CHECK(bridge_source_revision>0);
`;
