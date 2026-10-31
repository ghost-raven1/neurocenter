/** This bridge-owned adapter is shipped in the same archive; OpenCode never installs an unpinned SDK. */
export const ollamaAdapterUrl = new URL(
    import.meta.url.endsWith('.ts') ? './ollama-sdk.ts' : './ollama-sdk.js',
    import.meta.url,
).href;
