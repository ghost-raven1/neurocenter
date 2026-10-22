/** Trial receipts require working project access; ownership is checked again by the service. */
export function allowAgentReadinessRoute(level: number, method: string, suffix: string): boolean | undefined {
    if (!/^agents\/(?:readiness(?:[/%]|$)|.*\/readiness-trials(?:[/%]|$))/.test(suffix)) return undefined;
    if (level < 2) return false;
    const read = method === 'GET' || method === 'HEAD';
    if (suffix === 'agents/readiness') return read;
    const route = /^agents\/agent-[a-z0-9][a-z0-9-]{0,120}\/readiness-trials(?:\/([a-f0-9-]{36})(\/cancel)?)?$/.exec(suffix);
    if (!route) return false;
    return !route[1] || route[2] ? method === 'POST' : read;
}
