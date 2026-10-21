/** Platform defaults are independent of existing project budgets and survive process restarts. */
export const PLATFORM_QUOTA_SCHEMA=`
CREATE TABLE public.rag_platform_quota_policy (
    singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
    default_bytes bigint NOT NULL CHECK(default_bytes>0 AND default_bytes<=9007199254740991),
    maximum_bytes bigint NOT NULL CHECK(maximum_bytes>=default_bytes AND maximum_bytes<=9007199254740991),
    revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0),
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by text NOT NULL
);
CREATE TABLE public.rag_platform_quota_events (
    id bigserial PRIMARY KEY,actor text NOT NULL,before_policy jsonb NOT NULL,
    after_policy jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
`;

/** A separate table keeps frozen quota-001 objects intact while fencing stale policy deliveries. */
export const PLATFORM_QUOTA_CACHE_SCHEMA=`
CREATE TABLE public.rag_platform_quota_applied (
    singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
    revision bigint NOT NULL CHECK(revision>=0),
    default_bytes bigint NOT NULL CHECK(default_bytes>0 AND default_bytes<=9007199254740991),
    maximum_bytes bigint NOT NULL CHECK(maximum_bytes>=default_bytes AND maximum_bytes<=9007199254740991)
);
`;
