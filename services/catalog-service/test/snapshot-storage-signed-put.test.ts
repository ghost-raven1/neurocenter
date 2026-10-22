import 'reflect-metadata';
import { createHash, createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { Client } from 'minio';
import type { Pool } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { SnapshotStorage } from '../src/snapshots/snapshot-storage';

const accessKey = 'snapshot-signed-access', secretKey = 'snapshot-signed-secret', region = 'us-east-1', bucket = 'signed-snapshots';
const digest = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
const hmac = (key: string | Buffer, text: string): Buffer => createHmac('sha256', key).update(text).digest();
const servers: Server[] = [];
afterEach(async () => {
    for (const server of servers.splice(0)) {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        expect(server.listening).toBe(false);
    }
});

/** Independent SigV4 validation of real SDK traffic; neither the SDK nor HTTP transport is mocked. */
function signed(request: IncomingMessage, bytes: Buffer): boolean {
    const match = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([a-f0-9]{64})$/.exec(request.headers.authorization || '');
    if (!match) return false;
    const [, access, date, signedRegion, names, signature] = match, dateTime = String(request.headers['x-amz-date']), headers = names.split(';');
    if (access !== accessKey || signedRegion !== region || !/^\d{8}T\d{6}Z$/.test(dateTime) || !dateTime.startsWith(date)
        || !headers.includes('host') || [...headers].sort().join(';') !== names || request.headers['x-amz-content-sha256'] !== digest(bytes)
        || Object.keys(request.headers).some(name => name.startsWith('x-amz-') && !headers.includes(name))) return false;
    const canonicalHeaders = headers.map(name => name + ':' + String(request.headers[name]).trim().replace(/[ \t]+/g, ' ')).join('\n') + '\n';
    const [pathname, query = ''] = (request.url || '').split('?'), scope = `${date}/${region}/s3/aws4_request`;
    const canonicalQuery = query.split('&').filter(Boolean).sort().map(part => part.includes('=') ? part : part + '=').join('&');
    const canonical = [request.method, pathname, canonicalQuery, canonicalHeaders, names, digest(bytes)].join('\n');
    const key = hmac(hmac(hmac(hmac('AWS4' + secretKey, date), region), 's3'), 'aws4_request');
    return hmac(key, ['AWS4-HMAC-SHA256', dateTime, scope, digest(canonical)].join('\n')).toString('hex') === signature;
}

interface Intent { project_id: string; sha256: string; write_id: string; bytes: string; storage_id: string }
interface BlobRow { bytes: string; storage_id: string; version_id: string; state: 'LIVE' }
/** A narrow SQL boundary double rejects unknown SQL; this fixture makes no PostgreSQL acceptance claim. */
function ledger() {
    let intent: Intent | undefined, blob: BlobRow | undefined, pending: BlobRow | undefined, deleting = false;
    const events: string[] = [], releases: boolean[] = [];
    const query = async (sql: string, values: unknown[] = []) => {
        events.push(sql);
        if (sql.startsWith('SELECT pg_advisory_')) return { rows: [] };
        if (sql.startsWith('SELECT bytes,storage_id,version_id,state FROM project_snapshot_blobs')) return { rows: blob ? [{ ...blob }] : [] };
        if (sql.startsWith('SELECT * FROM project_snapshot_blob_writes WHERE')) return { rows: intent ? [{ ...intent }] : [] };
        if (sql.startsWith('SELECT (SELECT COALESCE(sum(bytes),0)')) return { rows: [{ bytes: '0' }] };
        if (sql.startsWith('INSERT INTO project_snapshot_blob_writes(')) {
            if (intent) throw Error('Duplicate fixture write intent');
            intent = { project_id: String(values[0]), sha256: String(values[1]), write_id: String(values[2]), bytes: String(values[3]), storage_id: String(values[4]) };
        } else if (sql === 'BEGIN') { pending = undefined; deleting = false; }
        else if (sql.startsWith('INSERT INTO project_snapshot_blobs(')) {
            if (!intent) throw Error('Registration without durable intent');
            pending = { bytes: String(values[2]), storage_id: String(values[3]), version_id: String(values[4]), state: 'LIVE' };
        } else if (sql.startsWith('DELETE FROM project_snapshot_blob_writes WHERE')) {
            if (values[2] !== intent?.write_id) throw Error('Removing another write intent'); deleting = true;
        } else if (sql === 'COMMIT') { blob = pending; if (deleting) intent = undefined; }
        else if (sql === 'ROLLBACK') { pending = undefined; deleting = false; }
        else throw Error('Unexpected fixture SQL: ' + sql);
        return { rows: [] };
    };
    const connection = { query, release: (discard: boolean) => releases.push(discard) };
    return { pool: { query, connect: async () => connection } as unknown as Pool, events, releases,
        intent: () => intent && { ...intent }, blob: () => blob && { ...blob } };
}

async function fixture() {
    const db = ledger(), project = 'signed-snapshot-project', bytes = Buffer.from('Exact snapshot chunk\0binary\xff'), sha = digest(bytes);
    const objectKey = 'projects/' + digest(project) + '/blobs/' + sha, version = 'signed-version-1';
    const puts: Array<{ signatureValid: boolean; unsignedContentType: boolean; nonce: string | string[] | undefined; bytes: Buffer }> = [];
    const requests: string[] = [], errors: string[] = [];
    let stored: { bytes: Buffer; nonce: string } | undefined, rejectPut = false;
    const server = createServer(async (request, response) => {
        const xml = (status: number, text: string) => { response.writeHead(status, { 'content-type': 'application/xml' }); response.end(text); };
        try {
            const chunks: Buffer[] = []; for await (const part of request) chunks.push(Buffer.from(part));
            const body = Buffer.concat(chunks), url = new URL(request.url || '/', 'http://127.0.0.1'), valid = signed(request, body);
            requests.push(request.method + ' ' + url.pathname + url.search);
            if (request.method === 'PUT') {
                const nonce = request.headers['x-amz-meta-neurocenter-snapshot-write'];
                const unsignedContentType = request.headers['content-type'] !== undefined
                    && !/SignedHeaders=[^,]*\bcontent-type(?:;|,)/.test(request.headers.authorization || '');
                puts.push({ signatureValid: valid, unsignedContentType, nonce, bytes: body });
                // Ceph20.2.4 rgw_auth_s3.cc:713-744 requires any supplied Content-Type to be signed.
                // https://github.com/ceph/ceph/blob/v20.2.4/src/rgw/rgw_auth_s3.cc#L713-L744
                if (!valid || unsignedContentType || rejectPut || nonce !== db.intent()?.write_id) {
                    xml(403, '<Error><Code>AccessDenied</Code><Message>Unsigned request header</Message></Error>'); return;
                }
                expect(db.blob()).toBeUndefined(); expect(url.pathname).toBe('/' + bucket + '/' + objectKey);
                stored = { bytes: body, nonce: String(nonce) };
                response.writeHead(200, { etag: '"' + digest(body) + '"', 'x-amz-version-id': version }); response.end(); return;
            }
            if (!valid) { xml(403, '<Error><Code>AccessDenied</Code></Error>'); return; }
            if (url.searchParams.has('policy')) { xml(404, '<Error><Code>NoSuchBucketPolicy</Code></Error>'); return; }
            if (url.searchParams.has('acl')) {
                xml(200, '<AccessControlPolicy><Owner><ID>owner</ID></Owner><AccessControlList><Grant><Grantee xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="CanonicalUser"><ID>owner</ID></Grantee><Permission>FULL_CONTROL</Permission></Grant></AccessControlList></AccessControlPolicy>'); return;
            }
            if (url.searchParams.has('versioning')) { xml(200, '<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>'); return; }
            if (url.searchParams.has('versions')) {
                xml(200, '<ListVersionsResult><Name>' + bucket + '</Name><IsTruncated>false</IsTruncated>'
                    + (stored ? '<Version><Key>' + objectKey + '</Key><VersionId>' + version + '</VersionId><IsLatest>true</IsLatest><LastModified>2026-10-22T00:00:00Z</LastModified><ETag>"' + sha + '"</ETag><Size>' + stored.bytes.length + '</Size><StorageClass>STANDARD</StorageClass></Version>' : '') + '</ListVersionsResult>'); return;
            }
            if (stored && url.pathname === '/' + bucket + '/' + objectKey && url.searchParams.get('versionId') === version) {
                response.writeHead(200, { 'content-length': stored.bytes.length, etag: '"' + sha + '"', 'last-modified': 'Thu, 22 Oct 2026 00:00:00 GMT',
                    'x-amz-version-id': version, 'x-amz-meta-neurocenter-snapshot-write': stored.nonce });
                response.end(request.method === 'HEAD' ? undefined : stored.bytes); return;
            }
            throw Error('Unexpected signed fixture request: ' + request.method + ' ' + request.url);
        } catch (error) { errors.push(String(error)); xml(500, '<Error><Code>FixtureFailure</Code></Error>'); }
    });
    servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing owned HTTP address');
    const config = { endpoint: 'http://127.0.0.1:' + address.port, bucket, region, accessKey, secretKey };
    return { db, project, bytes, sha, objectKey, version, puts, requests, errors, storage: new SnapshotStorage(db.pool, { s3: config }),
        client: new Client({ endPoint: '127.0.0.1', port: address.port, useSSL: false, region, accessKey, secretKey, retryOptions: { maximumRetryCount: 1 } }),
        rejectPut: (value: boolean) => { rejectPut = value; } };
}

describe('Snapshot PUT through the real SDK and a strict signed HTTP endpoint', () => {
    it('commits the exact verified object version and deduplicates without an unsigned Content-Type', async () => {
        const f = await fixture();
        const result = await f.storage.put(f.project, f.sha, f.bytes).then(() => 'complete', error => error);
        expect(f.puts).toHaveLength(1);
        expect(f.puts[0]).toMatchObject({ signatureValid: true, unsignedContentType: false });
        expect(f.puts[0].bytes).toEqual(f.bytes); expect(f.puts[0].nonce).toMatch(/^[a-f0-9-]{36}$/);
        expect(f.errors).toEqual([]); expect(result).toBe('complete');
        expect(f.db.blob()).toMatchObject({ bytes: String(f.bytes.length), version_id: f.version, state: 'LIVE' }); expect(f.db.intent()).toBeUndefined();
        expect(f.requests.some(value => value.startsWith('HEAD ') && value.includes('versionId=' + f.version))).toBe(true);
        expect(f.requests.some(value => value.startsWith('GET ') && value.includes('versionId=' + f.version))).toBe(true);
        await f.storage.put(f.project, f.sha, f.bytes); expect(await f.storage.read(f.project, f.sha)).toEqual(f.bytes);
        expect(f.puts).toHaveLength(1); expect(f.db.events.filter(sql => sql === 'COMMIT')).toHaveLength(1);
        expect(f.db.releases).toEqual([false, false]); expect(f.errors).toEqual([]);
    });
    it('demonstrates that the former explicit Content-Type is rejected despite a valid SDK signature', async () => {
        const f = await fixture();
        await f.db.pool.query('INSERT INTO project_snapshot_blob_writes(project_id,sha256,write_id,bytes,storage_id) VALUES($1,$2,$3,$4,$5)',
            [f.project, f.sha, 'control-write', f.bytes.length, f.storage.storageId]);
        await expect(f.client.putObject(bucket, f.objectKey, f.bytes, f.bytes.length,
            { 'Content-Type': 'application/octet-stream', 'X-Amz-Meta-Neurocenter-Snapshot-Write': 'control-write' })).rejects.toMatchObject({ code: 'AccessDenied' });
        expect(f.puts).toHaveLength(1); expect(f.puts[0]).toMatchObject({ signatureValid: true, unsignedContentType: true, nonce: 'control-write' });
        expect(f.puts[0].bytes).toEqual(f.bytes);
        expect((await f.client.putObject(bucket, f.objectKey, f.bytes, f.bytes.length,
            { 'X-Amz-Meta-Neurocenter-Snapshot-Write': 'control-write' })).versionId).toBe(f.version);
        expect(f.puts).toHaveLength(2); expect(f.puts[1]).toMatchObject({ signatureValid: true, unsignedContentType: false, nonce: 'control-write' });
        expect(f.puts[1].bytes).toEqual(f.bytes); expect(f.db.events).toHaveLength(1); expect(f.errors).toEqual([]);
    });
    it('preserves the write intent on rejection and reuses its signed nonce when the same upload is retried', async () => {
        const f = await fixture(); f.rejectPut(true);
        await expect(f.storage.put(f.project, f.sha, f.bytes)).rejects.toMatchObject({ code: 'AccessDenied' });
        const intent = f.db.intent(); expect(intent).toBeDefined(); expect(f.db.blob()).toBeUndefined();
        expect(f.db.events).not.toContain('BEGIN'); expect(f.db.releases).toEqual([false]);
        f.rejectPut(false); await f.storage.put(f.project, f.sha, f.bytes);
        expect(f.puts).toHaveLength(2); expect(f.puts.map(put => put.nonce)).toEqual([intent!.write_id, intent!.write_id]);
        expect(f.puts.every(put => put.signatureValid && !put.unsignedContentType && put.bytes.equals(f.bytes))).toBe(true);
        expect(f.db.events.filter(sql => sql.startsWith('INSERT INTO project_snapshot_blob_writes('))).toHaveLength(1);
        expect(f.db.blob()?.version_id).toBe(f.version); expect(f.db.intent()).toBeUndefined(); expect(f.errors).toEqual([]);
    });
});
