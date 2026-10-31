import type { Request } from 'express';
import { isIP } from 'node:net';

const address = (value: string): string => (value.startsWith('::ffff:') ? value.slice(7) : value);
/** Forwarded TLS is accepted only from an explicitly configured proxy socket address. */
export function deviceCredentialTransport(req: Request, env: NodeJS.ProcessEnv = process.env): boolean {
    if ((req.socket as typeof req.socket & { encrypted?: boolean }).encrypted === true) return true;
    const remote = address(req.socket.remoteAddress || '');
    const trusted = (env.NEUROCENTER_TLS_PROXY_ADDRESSES || '')
        .split(',')
        .map((v) => address(v.trim()))
        .filter(Boolean);
    if (
        trusted.length &&
        trusted.every((value) => isIP(value)) &&
        trusted.includes(remote) &&
        req.headers['x-forwarded-proto'] === 'https'
    )
        return true;
    if (env.NODE_ENV === 'production' || !['127.0.0.1', '::1'].includes(remote)) return false;
    const host = req.headers.host;
    if (typeof host !== 'string' || /[\s/@?#]/.test(host)) return false;
    try {
        return ['127.0.0.1', '[::1]', 'localhost'].includes(new URL('http://' + host).hostname);
    } catch {
        return false;
    }
}
