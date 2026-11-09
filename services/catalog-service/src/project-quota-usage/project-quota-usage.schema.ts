/** Version-neutral additive SQL; ROOT owns contiguous migration registration and reset classification. */
export const PROJECT_QUOTA_USAGE_SCHEMA_SQL = `
CREATE TABLE project_quota_usage (
 project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 dimension text NOT NULL CHECK(dimension IN ('current','retention','staging')),
 used_bytes bigint NOT NULL DEFAULT 0 CHECK(used_bytes>=0),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(project_id,dimension)
);
CREATE TABLE project_quota_usage_requests (
 project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 dimension text NOT NULL CHECK(dimension IN ('current','retention','staging')),
 request_key text NOT NULL CHECK(length(request_key)<=512),
 delta_bytes bigint NOT NULL CHECK(delta_bytes<>0 AND delta_bytes>=-9007199254740991 AND delta_bytes<=9007199254740991),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(project_id,dimension,request_key)
);
`;
