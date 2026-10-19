interface IAuditRefreshState { refresh: () => void; loading: boolean; }

/** Доставленный фоном аудит перечитывается только на открытой видимой странице. */
export function startAuditRefresh(current: () => IAuditRefreshState): () => void {
    const timer = setInterval(() => {
        if (document.visibilityState !== 'visible') { return; }
        const state = current();
        if (!state.loading) { state.refresh(); }
    }, 10000);
    return () => clearInterval(timer);
}
