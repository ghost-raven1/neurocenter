export interface ILocalRagUi {
    schemaVersion: 1;
    application: 'opencode-rag';
    entrypoint: 'opencode-rag.mjs';
    args: string[];
}
export function localRagUi(pkg: unknown): ILocalRagUi | undefined;
export function ragUiReady(value: unknown): { url: string; port: number };
