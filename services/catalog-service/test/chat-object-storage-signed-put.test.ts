import 'reflect-metadata';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatObjectStorage, chatObjectDigest, type ChatObjectReference } from '../src/model-chat/chat-object-storage';

const accessKey = 'signed-put-fixture-access', secretKey = 'signed-put-fixture-secret', region = 'us-east-1';
const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const hmac = (key: string | Buffer, value: string): Buffer => createHmac('sha256', key).update(value).digest();
const servers: Server[] = [];
afterEach(async () => {
    for (const server of servers.splice(0)) {
        server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        expect(server.listening).toBe(false);
    }
});

/** Verify the actual SDK request independently; no SDK method or HTTP transport is mocked. */
function signed(request: IncomingMessage, bytes: Buffer): boolean {
    const match = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([a-f0-9]{64})$/.exec(request.headers.authorization || '');
    if (!match) return false;
    const [, access, date, signedRegion, names, signature] = match, dateTime = String(request.headers['x-amz-date']);
    const headers = names.split(';');
    if (access !== accessKey || signedRegion !== region || !/^\d{8}T\d{6}Z$/.test(dateTime) || !dateTime.startsWith(date)
        || !headers.includes('host') || !headers.includes('x-amz-meta-neurocenter-sha256') || [...headers].sort().join(';') !== names
        || request.headers['x-amz-content-sha256'] !== digest(bytes)) return false;
    const canonicalHeaders = headers.map(name => name + ':' + String(request.headers[name]).trim().replace(/[ \t]+/g, ' ')).join('\n') + '\n';
    const [pathname, query = ''] = (request.url || '').split('?'), scope = `${date}/${region}/s3/aws4_request`;
    const canonical = [request.method, pathname, query, canonicalHeaders, names, digest(bytes)].join('\n');
    const key = hmac(hmac(hmac(hmac('AWS4' + secretKey, date), region), 's3'), 'aws4_request');
    return hmac(key, ['AWS4-HMAC-SHA256', dateTime, scope, digest(canonical)].join('\n')).toString('hex') === signature;
}

async function fixture() {
    const requests: Array<{ bytes: Buffer; signatureValid: boolean; metadata: string | string[] | undefined; unsignedContentType: boolean }> = [];
    // Ceph v20.2.4 rejects a supplied Content-Type absent from SignedHeaders:
    // https://github.com/ceph/ceph/blob/v20.2.4/src/rgw/rgw_auth_s3.cc#L713-L744
    const server = createServer(async (request, response) => {
        try {
            const chunks: Buffer[] = []; for await (const part of request) chunks.push(Buffer.from(part));
            const bytes = Buffer.concat(chunks), signatureValid = signed(request, bytes);
            const unsignedContentType = request.headers['content-type'] !== undefined
                && !/SignedHeaders=[^,]*\bcontent-type(?:;|,)/.test(request.headers.authorization || '');
            requests.push({ bytes, signatureValid, metadata: request.headers['x-amz-meta-neurocenter-sha256'], unsignedContentType });
            if (!signatureValid || request.headers['x-amz-meta-neurocenter-sha256'] !== digest(bytes) || unsignedContentType) {
                response.writeHead(403, { 'content-type': 'application/xml' });
                response.end('<Error><Code>AccessDenied</Code><Message>Unsigned request header</Message></Error>'); return;
            }
            response.writeHead(200, { etag: '"' + digest(bytes) + '"', 'x-amz-version-id': 'fixture-version-1' }); response.end();
        } catch { response.writeHead(500); response.end(); }
    });
    servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing owned HTTP address');
    const objects = new ChatObjectStorage({ endpoint: 'http://127.0.0.1:' + address.port, region, accessKey, secretKey,
        projectBucket: 'signed-projects', personalBucket: 'signed-personal' }, { allowInsecureLocal: true });
    const bytes = Buffer.from('Private original\0with exact binary bytes\xff');
    const reference: ChatObjectReference = { storage_id: objects.storageId, bucket: objects.config.personalBucket,
        object_key: 'owners/' + chatObjectDigest('owner') + '/chats/' + randomUUID() + '/' + randomUUID(),
        version_id: null, sha256: digest(bytes), bytes: bytes.length };
    return { objects, reference, bytes, requests };
}

describe('Chat PUT through the real SDK and a strict signed HTTP endpoint', () => {
    it('uploads exact bytes with signed SHA metadata without an unsigned Content-Type', async () => {
        const f = await fixture(), before = { ...f.reference };
        const result = await f.objects.put(f.reference, f.bytes).then(version => ({ version }), error => ({ error }));
        expect(f.requests).toHaveLength(1);
        expect(f.requests[0]).toMatchObject({ signatureValid: true, metadata: f.reference.sha256, unsignedContentType: false });
        expect(f.requests[0].bytes).toEqual(f.bytes); expect(result).toEqual({ version: 'fixture-version-1' });
        expect(f.reference).toEqual(before);
    });
    it('rejects the former explicit Content-Type despite a valid signature and unchanged SHA metadata', async () => {
        const f = await fixture();
        await expect(f.objects.client.putObject(f.reference.bucket, f.reference.object_key, f.bytes, f.bytes.length,
            { 'Content-Type': 'application/octet-stream', 'X-Amz-Meta-Neurocenter-Sha256': f.reference.sha256 })).rejects.toMatchObject({ code: 'AccessDenied' });
        expect(f.requests).toHaveLength(1);
        expect(f.requests[0]).toMatchObject({ signatureValid: true, metadata: f.reference.sha256, unsignedContentType: true });
        expect(f.requests[0].bytes).toEqual(f.bytes);
    });
});
