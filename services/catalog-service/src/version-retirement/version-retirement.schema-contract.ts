/** Migration56 physical facts measured on owned PostgreSQL16. */
export const VERSION_RETIREMENT_SCHEMA_CONTRACT = [
  {
    "kind": "column",
    "id": "ai_plugin_versions.status",
    "definition": {
      "type": "text",
      "default": "'active'::text",
      "notNull": true
    }
  },
  {
    "kind": "column",
    "id": "model_catalog_versions.status",
    "definition": {
      "type": "text",
      "default": "'active'::text",
      "notNull": true
    }
  },
  {
    "kind": "constraint",
    "id": "ai_plugin_versions.ai_plugin_versions_status_check",
    "definition": {
      "type": "c",
      "validated": true,
      "definition": "CHECK (status = ANY (ARRAY['active'::text, 'retired'::text]))"
    }
  },
  {
    "kind": "constraint",
    "id": "model_catalog_versions.model_catalog_versions_status_check",
    "definition": {
      "type": "c",
      "validated": true,
      "definition": "CHECK (status = ANY (ARRAY['active'::text, 'retired'::text]))"
    }
  }
];
