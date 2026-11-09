/** Migration54 physical facts measured on owned PostgreSQL (15.6 loopback, entry 2.9; DDL version-neutral). */
export const RATE_LIMIT_WINDOWS_SCHEMA_CONTRACT = [
  {
    "kind": "column",
    "id": "rate_limit_windows.count",
    "definition": {
      "type": "integer",
      "default": "1",
      "notNull": true
    }
  },
  {
    "kind": "column",
    "id": "rate_limit_windows.key",
    "definition": {
      "type": "text",
      "default": null,
      "notNull": true
    }
  },
  {
    "kind": "column",
    "id": "rate_limit_windows.scope",
    "definition": {
      "type": "text",
      "default": null,
      "notNull": true
    }
  },
  {
    "kind": "column",
    "id": "rate_limit_windows.window_start",
    "definition": {
      "type": "timestamp with time zone",
      "default": null,
      "notNull": true
    }
  },
  {
    "kind": "constraint",
    "id": "rate_limit_windows.rate_limit_windows_count_check",
    "definition": {
      "type": "c",
      "validated": true,
      "definition": "CHECK (count > 0)"
    }
  },
  {
    "kind": "constraint",
    "id": "rate_limit_windows.rate_limit_windows_pkey",
    "definition": {
      "type": "p",
      "validated": true,
      "definition": "PRIMARY KEY (scope, key, window_start)"
    }
  },
  {
    "kind": "index",
    "id": "rate_limit_windows_pkey",
    "definition": {
      "ready": true,
      "valid": true,
      "definition": "CREATE UNIQUE INDEX rate_limit_windows_pkey ON rate_limit_windows USING btree (scope, key, window_start)"
    }
  },
  {
    "kind": "index",
    "id": "rate_limit_windows_window_start_idx",
    "definition": {
      "ready": true,
      "valid": true,
      "definition": "CREATE INDEX rate_limit_windows_window_start_idx ON rate_limit_windows USING btree (window_start)"
    }
  },
  {
    "kind": "table",
    "id": "rate_limit_windows",
    "definition": {
      "kind": "r",
      "persistence": "p"
    }
  }
];
