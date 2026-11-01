export interface ILocalRagCore {
    schemaVersion: 1;
    application: 'opencode-rag';
    entrypoint: 'opencode-rag.mjs';
}
export function localRagCore(pkg: unknown): ILocalRagCore | undefined;
