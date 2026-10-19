import type {RuntimeTarget} from './tool-runtime-source.cjs';
export const RAG_PLUGIN_SOURCE: Readonly<{
    url: string; commit: string; entrypoint: string; version: string; adapter: 'opencode-rag-plugin';
    supportedTargets: readonly RuntimeTarget[];
}>;
export function isPreparedRagRepository(source: {url?: string; commit?: string; subdirectory?: string; entrypoint?: string}): boolean;
