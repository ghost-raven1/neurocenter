/** localhost и частные API допустимы; credentials и параметры URL задаются отдельными полями. */
export function isRemoteApiUrl(value: unknown): boolean {
    if (typeof value !== 'string' || !value || /[\s\\\x00-\x1f\x7f]/.test(value)) return false;
    try {
        const url = new URL(value);
        return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
    } catch { return false; }
}
