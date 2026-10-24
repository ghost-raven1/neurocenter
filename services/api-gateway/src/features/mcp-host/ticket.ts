import { createHmac, timingSafeEqual } from 'node:crypto';

/** Билет хоста без хранения в БД: HMAC от заявлений. Срок ограничен, замену выдает новая установка. */
export interface HostedMcpClaim {
    artifactSha256: string;
    entrypoint: string;
    executable: boolean;
    name: string;
    compressedBytes: number;
    unpackedBytes?:number;
    filesCount?:number;
    session?:HostedMcpSession;
    /** Internal research requests use a private, short-lived child; never serialized into public tickets. */
    researchSessionId?:string;
    /** Private role sessions are never serialized into public device tickets. */
    operationSessionId?:string;
    /** Pinned remote endpoints belong to private role sessions and never enter public host tickets. */
    operationRemote?:{url:string;headers:Record<string,string>};
    /** Literal arguments come only from the same immutable catalogue package or its proven producer ABI. */
    operationArgs?:string[];
    exp: number;
}
export interface HostedMcpSession {deviceId:string;projectId:string;assetId:string;version:number;manifest:string;}
/** A signed host ticket identifies a revocable device and one immutable project assignment. */
export function validHostedMcpSession(value:unknown):value is HostedMcpSession {
    const session=value as Partial<HostedMcpSession>|null;
    return !!session&&typeof session==='object'&&!Array.isArray(session)&&Object.keys(session).sort().join(',')==='assetId,deviceId,manifest,projectId,version'
        &&['deviceId','projectId','assetId'].every(key=>typeof session[key as keyof HostedMcpSession]==='string'&&String(session[key as keyof HostedMcpSession]).length>0&&String(session[key as keyof HostedMcpSession]).length<=200)
        &&Number.isSafeInteger(session.version)&&Number(session.version)>0&&typeof session.manifest==='string'&&/^[a-f0-9]{64}$/.test(session.manifest);
}

const secret = () => process.env.NEUROCENTER_MCP_HOST_SECRET || process.env.NEUROCENTER_INTERNAL_TOKEN || '';
export const HOSTED_MCP_TTL_MS = 30 * 86400 * 1000;

export function issueHostedMcpTicket(claim: Omit<HostedMcpClaim, 'exp'>): string {
    const guard = secret();
    if (guard.length < 16) { throw new Error('Секрет хоста MCP не задан.'); }
    if(!validHostedMcpSession(claim.session))throw new Error('Нужно подтверждённое назначение MCP и подключение компьютера.');
    const {artifactSha256,entrypoint,executable,name,compressedBytes,unpackedBytes,filesCount,session}=claim;
    const payload = Buffer.from(JSON.stringify({artifactSha256,entrypoint,executable,name,compressedBytes,
        unpackedBytes,filesCount,session,exp:Date.now()+HOSTED_MCP_TTL_MS})).toString('base64url');
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
    const { artifactSha256, entrypoint, executable, name, compressedBytes, exp,unpackedBytes,filesCount,session } = claim;
    if (
        typeof artifactSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(artifactSha256)
        || typeof entrypoint !== 'string' || !entrypoint || entrypoint.length > 240
        || entrypoint.includes('..') || entrypoint.startsWith('/')
        || typeof executable !== 'boolean'
        || typeof name !== 'string' || !name || name.length > 200
        || typeof compressedBytes !== 'number' || !Number.isSafeInteger(compressedBytes) || compressedBytes < 1 || compressedBytes > 2 * 1024 * 1024 * 1024
        || typeof exp !== 'number' || exp < Date.now()
        || unpackedBytes!==undefined&&(!Number.isSafeInteger(unpackedBytes)||unpackedBytes<1||unpackedBytes>1024**3)
        || filesCount!==undefined&&(!Number.isSafeInteger(filesCount)||filesCount<1||filesCount>20000)
        || !validHostedMcpSession(session)
    ) { return undefined; }
    return { artifactSha256, entrypoint, executable, name, compressedBytes, exp,session,...(unpackedBytes!==undefined?{unpackedBytes}:{}),...(filesCount!==undefined?{filesCount}:{}) };
}
