import { createHmac, timingSafeEqual } from 'node:crypto';

/** Билет хоста без хранения в БД: HMAC от заявлений. Срок ограничен, замену выдает новая установка. */
export interface HostedMcpClaim {
    artifactSha256: string;
    entrypoint: string;
    executable: boolean;
    name: string;
    compressedBytes: number;
    exp: number;
}

const secret = () => process.env.NEUROCENTER_MCP_HOST_SECRET || process.env.NEUROCENTER_INTERNAL_TOKEN || '';
export const HOSTED_MCP_TTL_MS = 30 * 86400 * 1000;

export function issueHostedMcpTicket(claim: Omit<HostedMcpClaim, 'exp'>): string {
    const guard = secret();
    if (guard.length < 16) { throw new Error('Секрет хоста MCP не задан.'); }
    const payload = Buffer.from(JSON.stringify({ ...claim, exp: Date.now() + HOSTED_MCP_TTL_MS })).toString('base64url');
    return payload + '.' + createHmac('sha256', guard).update(payload).digest('base64url');
}

export function verifyHostedMcpTicket(ticket: string): HostedMcpClaim | undefined {
    const guard = secret();
    if (guard.length < 16 || typeof ticket !== 'string' || ticket.length > 2048) { return undefined; }
    const dot = ticket.lastIndexOf('.');
    if (dot < 1) { return undefined; }
    const payload = ticket.slice(0, dot);
    let actual: Buffer;
    try { actual = Buffer.from(ticket.slice(dot + 1), 'base64url'); } catch { return undefined; }
    const expected = createHmac('sha256', guard).update(payload).digest();
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) { return undefined; }
    let raw: unknown;
    try { raw = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return undefined; }
    const claim = raw as Partial<HostedMcpClaim> | null;
    if (!claim || typeof claim !== 'object' || Array.isArray(claim)) { return undefined; }
    const { artifactSha256, entrypoint, executable, name, compressedBytes, exp } = claim;
    if (
        typeof artifactSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(artifactSha256)
        || typeof entrypoint !== 'string' || !entrypoint || entrypoint.length > 240
        || entrypoint.includes('..') || entrypoint.startsWith('/')
        || typeof executable !== 'boolean'
        || typeof name !== 'string' || !name || name.length > 200
        || typeof compressedBytes !== 'number' || !Number.isSafeInteger(compressedBytes) || compressedBytes < 1 || compressedBytes > 2 * 1024 * 1024 * 1024
        || typeof exp !== 'number' || exp < Date.now()
    ) { return undefined; }
    return { artifactSha256, entrypoint, executable, name, compressedBytes, exp };
}
