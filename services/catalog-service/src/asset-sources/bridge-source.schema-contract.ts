/** Frozen structural facts introduced by migration 9. */
export const BRIDGE_SOURCE_SCHEMA_CONTRACT=[
 {
  "kind": "table",
  "id": "bridge_source_settings",
  "definition": {
   "kind": "r",
   "persistence": "p"
  }
 },
 {
  "kind": "table",
  "id": "bridge_source_checks",
  "definition": {
   "kind": "r",
   "persistence": "p"
  }
 },
 {
  "kind": "column",
  "id": "bridge_source_settings.singleton",
  "definition": {
   "type": "boolean",
   "default": "true",
   "notNull": true
  }
 },
 {
  "kind": "column",
  "id": "bridge_source_settings.revision",
  "definition": {
   "type": "integer",
   "default": "1",
   "notNull": true
  }
 },
 {
  "kind": "column",
  "id": "bridge_source_settings.updated_at",
  "definition": {
   "type": "timestamp with time zone",
   "default": "now()",
   "notNull": true
  }
 },
 {
  "kind": "column",
  "id": "bridge_source_checks.checked_at",
  "definition": {
   "type": "timestamp with time zone",
   "default": "now()",
   "notNull": true
  }
 },
 {
  "kind": "column",
  "id": "bridge_source_settings.check_commit",
  "definition": {
   "type": "text",
   "default": null,
   "notNull": false
  }
 },
 {
  "kind": "column",
  "id": "bridge_source_settings.installed_repository",
  "definition": {
   "type": "text",
   "default": null,
   "notNull": false
  }
 },
 {
  "kind": "column",
  "id": "bridge_source_settings.checked_at",
  "definition": {
   "type": "timestamp with time zone",
   "default": null,
   "notNull": false
  }
 },
 {
  "kind": "column",
  "id": "bridge_source_settings.check_token",
  "definition": {
   "type": "uuid",
   "default": null,
   "notNull": false
  }
 },
 {
  "kind": "column",
  "id": "bridge_source_checks.pin",
  "definition": {
   "type": "jsonb",
   "default": null,
   "notNull": true
  }
 },
 {
  "kind": "column",
  "id": "bridge_source_settings.error",
  "definition": {
   "type": "text",
   "default": null,
   "notNull": false
  }
 },
 {
  "kind": "column",
  "id": "bridge_source_checks.repository",
  "definition": {
   "type": "text",
   "default": null,
   "notNull": true
  }
 },
 {
  "kind": "column",
  "id": "asset_source_jobs.bridge_source_revision",
  "definition": {
   "type": "integer",
   "default": null,
   "notNull": false
  }
 },
 {
  "kind": "column",
  "id": "bridge_source_checks.index",
  "definition": {
   "type": "jsonb",
   "default": null,
   "notNull": true
  }
 },
 {
  "kind": "column",
  "id": "bridge_source_checks.commit",
  "definition": {
   "type": "text",
   "default": null,
   "notNull": true
  }
 },
 {
  "kind": "column",
  "id": "bridge_source_settings.attempted_at",
  "definition": {
   "type": "timestamp with time zone",
   "default": null,
   "notNull": false
  }
 },
 {
  "kind": "column",
  "id": "bridge_source_settings.updated_by",
  "definition": {
   "type": "text",
   "default": null,
   "notNull": false
  }
 },
 {
  "kind": "column",
  "id": "bridge_source_settings.url",
  "definition": {
   "type": "text",
   "default": null,
   "notNull": true
  }
 },
 {
  "kind": "column",
  "id": "bridge_source_settings.installed_asset_id",
  "definition": {
   "type": "text",
   "default": null,
   "notNull": false
  }
 },
 {
  "kind": "column",
  "id": "bridge_source_checks.assets",
  "definition": {
   "type": "jsonb",
   "default": null,
   "notNull": true
  }
 },
 {
  "kind": "constraint",
  "id": "bridge_source_settings.bridge_source_settings_singleton_check",
  "definition": {
   "type": "c",
   "validated": true,
   "definition": "CHECK (singleton)"
  }
 },
 {
  "kind": "constraint",
  "id": "bridge_source_settings.bridge_source_settings_revision_check",
  "definition": {
   "type": "c",
   "validated": true,
   "definition": "CHECK (revision > 0)"
  }
 },
 {
  "kind": "constraint",
  "id": "bridge_source_settings.bridge_source_settings_check",
  "definition": {
   "type": "c",
   "validated": true,
   "definition": "CHECK ((installed_repository IS NULL) = (installed_asset_id IS NULL))"
  }
 },
 {
  "kind": "constraint",
  "id": "bridge_source_settings.bridge_source_settings_pkey",
  "definition": {
   "type": "p",
   "validated": true,
   "definition": "PRIMARY KEY (singleton)"
  }
 },
 {
  "kind": "constraint",
  "id": "bridge_source_checks.bridge_source_checks_commit_check",
  "definition": {
   "type": "c",
   "validated": true,
   "definition": "CHECK (commit ~ '^[a-f0-9]{40}$'::text)"
  }
 },
 {
  "kind": "constraint",
  "id": "bridge_source_checks.bridge_source_checks_pkey",
  "definition": {
   "type": "p",
   "validated": true,
   "definition": "PRIMARY KEY (repository, commit)"
  }
 },
 {
  "kind": "constraint",
  "id": "asset_source_jobs.asset_source_jobs_bridge_source_revision_check",
  "definition": {
   "type": "c",
   "validated": true,
   "definition": "CHECK (bridge_source_revision > 0)"
  }
 },
 {
  "kind": "index",
  "id": "bridge_source_settings_pkey",
  "definition": {
   "ready": true,
   "valid": true,
   "definition": "CREATE UNIQUE INDEX bridge_source_settings_pkey ON bridge_source_settings USING btree (singleton)"
  }
 },
 {
  "kind": "index",
  "id": "bridge_source_checks_pkey",
  "definition": {
   "ready": true,
   "valid": true,
   "definition": "CREATE UNIQUE INDEX bridge_source_checks_pkey ON bridge_source_checks USING btree (repository, commit)"
  }
 }
] as const;
