export interface IBundledBuildSource {
    type: 'bundled';
    id: string;
    revision: string;
}
export interface IBundledCatalogPlan {
    id: string;
    kind: 'mcp' | 'plugin' | 'model' | 'bridge';
    name: string;
    description: string;
    sourceRevision: string;
    metadataSha256?: string;
    revision: string;
    delivery: { type: string; recipe?: string; automatic?: boolean };
    /** 1.3.0: маркеры обязательного системного ассета (all-or-nothing; см. контракт поставки). */
    system?: boolean;
    required?: boolean;
    subsystem?: 'core' | 'rag' | 'system-roles' | 'agent-team';
    note?: string;
}
export interface IBundledCatalogFile {
    path: string;
    sha256: string;
    bytes: number;
}
export interface IBundledRecipe {
    schemaVersion: 1;
    key: string;
    kind: 'mcp' | 'plugin';
    name: string;
    description: string;
    revision: string;
    tags?: string[];
    targets?: string[];
    source: { type: string; directory?: string; entrypoint?: string; adapter?: string };
    producer?: { schemaVersion: 1; id: string; revision: string; producerSha256: string };
    [key: string]: unknown;
}
export function validateBundledBuildSource(value: unknown): IBundledBuildSource;
export function readBundledCatalog(root?: string): Promise<{
    pin: import('./asset-source-client.cjs').IAssetSourcePin;
    revision: string;
    producerSha256: string;
    manifest: { history: { repository: string }; files: IBundledCatalogFile[] };
    plans: IBundledCatalogPlan[];
    historicalPins: import('./asset-source-client.cjs').IAssetSourcePin[];
    metadata(sha: string, maximum: number): Promise<Buffer | undefined>;
    read(path: string): Promise<Buffer>;
}>;
export function bundledBuildRecipe(
    value: unknown,
    root?: string,
): Promise<{
    recipe: IBundledRecipe;
    plan: IBundledCatalogPlan;
    recipePath: string;
    bundle: Awaited<ReturnType<typeof readBundledCatalog>>;
}>;
export function checkedFile(root: string, path: string, sha256: string, maximum: number): Promise<Buffer>;
export function readBundledComponent(
    name: string,
    root?: string,
): Promise<{
    provenance: {
        schemaVersion: 1;
        repository: string;
        commit: string;
        license: string | null;
        files: IBundledCatalogFile[];
    };
    files: Map<string, Buffer>;
}>;
export function verifyBundledProducer(
    sha256: string,
    root?: string,
): Promise<{ schemaVersion: 1; files: IBundledCatalogFile[] }>;
