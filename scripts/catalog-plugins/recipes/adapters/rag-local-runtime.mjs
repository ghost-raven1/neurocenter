/** Ограничивает нагрузку известного проектного CPU-runtime, сохраняя остальные подключения. */
export function applyLocalRuntimeProfile(config) {
    const { provider, model, baseUrl } = config.embedding;
    if (provider !== 'ollama' || model !== 'qwen3-embedding:4b') return config;
    let url;
    try { url = new URL(baseUrl); } catch { return config; }
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
        || url.port !== '11435' || url.pathname.replace(/\/+$/, '') !== '/api'
        || url.username || url.password || /[?#]/.test(url.href)) return config;
    return { ...config,
        embedding: { ...config.embedding, timeoutMs: 120_000 },
        indexing: { ...config.indexing, embedBatchSize: 1, embedConcurrency: 1 },
    };
}
