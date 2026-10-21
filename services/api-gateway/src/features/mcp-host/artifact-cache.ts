import axios from 'axios';
import { constants, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {inspectRuntimeArchive,portablePath,type RuntimeArtifact} from '../../../../shared/runtime-artifacts.cjs';
import {hostRuntimeTarget} from './host-target';
import type { HostedMcpClaim } from './ticket';

const cacheRoot = (): string => path.resolve(process.env.NEUROCENTER_MCP_HOST_DIR || path.join(os.tmpdir(), 'neurocenter-mcp-host'));
const inflight = new Map<string, Promise<string>>();

/** Одна развёртка на SHA-256: скачивание с каталога по внутреннему токену, TAR без чужих флагов, копия только своих файлов. */
export async function materializeArtifact(claim: HostedMcpClaim, catalogUrl: string, internalToken: string): Promise<string> {
    const finalRoot = path.join(cacheRoot(), 'artifacts', claim.artifactSha256);
    if (await ready(finalRoot, claim.entrypoint)) { return finalRoot; }
    const pending = inflight.get(claim.artifactSha256);
    if (pending) { return pending; }
    const task = build(claim, finalRoot, catalogUrl, internalToken).finally(() => inflight.delete(claim.artifactSha256));
    inflight.set(claim.artifactSha256, task);
    return task;
}

async function build(claim: HostedMcpClaim, finalRoot: string, catalogUrl: string, internalToken: string): Promise<string> {
    const stage = path.join(cacheRoot(), 'building', `.build-${claim.artifactSha256.slice(0, 12)}-${randomUUID()}`);
    const archive = path.join(stage, 'artifact.tar.gz');
    const unpack = path.join(stage, 'unpack');
    try {
        await fs.lstat(finalRoot).then(info => { if (info.isDirectory()) return fs.rm(finalRoot, { recursive: true, force: true }); }, () => undefined);
        await fs.mkdir(path.dirname(finalRoot), { recursive: true });
        await fs.mkdir(stage, { recursive: true, mode: 0o700 });
        await fs.mkdir(unpack, { recursive: true, mode: 0o700 });
        const response = await axios.get(`${catalogUrl.replace(/\/+$/, '')}/internal/mcp-host/artifact/${claim.artifactSha256}`, {
            responseType: 'stream', timeout: 120000, maxContentLength: claim.compressedBytes, maxBodyLength: claim.compressedBytes,
            headers: { 'x-neurocenter-internal': internalToken, 'accept-encoding': 'gzip' },
        });
        if (response.status !== 200) { throw new Error('Комплект хоста недоступен в каталоге.'); }
        let bytes = 0;const hash=createHash('sha256');
        const bounded=new Transform({transform(chunk:Buffer,_encoding,callback){
            bytes+=chunk.length;
            if(bytes>claim.compressedBytes){callback(new Error('Комплект хоста больше одобренной описи.'));return;}
            hash.update(chunk);callback(null,chunk);
        }});
        await pipeline(response.data,bounded,createWriteStream(archive,{mode:0o600,flags:'wx'}));
        if (bytes !== claim.compressedBytes||hash.digest('hex')!==claim.artifactSha256) { throw new Error('Размер или SHA комплекта хоста не совпадает с описью.'); }
        const descriptor:RuntimeArtifact={target:hostRuntimeTarget(),sha256:claim.artifactSha256,compressedBytes:claim.compressedBytes,entrypoint:claim.entrypoint,executable:claim.executable,
            unpackedBytes:claim.unpackedBytes??Number(response.headers['x-neurocenter-unpacked-bytes']),filesCount:claim.filesCount??Number(response.headers['x-neurocenter-files-count'])};
        const entries=await inspectRuntimeArchive(archive,descriptor,{destination:unpack});
        const entry = await fs.lstat(path.join(unpack, claim.entrypoint)).catch(() => null);
        if (!entry || !entry.isFile()) { throw new Error('Точка входа отсутствует в развёрнутом комплекте.'); }
        const handle = await fs.open(path.join(unpack, '.ready'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o400);
        try { await handle.writeFile(JSON.stringify({ schemaVersion: 2, sha256: claim.artifactSha256,entries }));await handle.sync(); }
        finally { await handle.close(); }
        await fs.rename(unpack,finalRoot);
        await fs.rm(stage,{recursive:true,force:true});
        return finalRoot;
    } catch (error) {
        await fs.rm(stage, { recursive: true, force: true });
        throw new Error('Комплект хоста недоступен. Повторите подключение.');
    }
}

async function ready(root: string, entrypoint: string): Promise<boolean> {
    try {
        const marker = await fs.lstat(path.join(root, '.ready'));
        const entry = await fs.lstat(path.join(root, entrypoint));
        if(!marker.isFile()||marker.size>8*1024*1024||!entry.isFile())return false;
        const receipt=JSON.parse(await fs.readFile(path.join(root,'.ready'),'utf8'));
        if(receipt.schemaVersion!==2||receipt.sha256!==path.basename(root)||!Array.isArray(receipt.entries)||!receipt.entries.length||receipt.entries.length>20000)return false;
        for(const file of receipt.entries){
            if(!portablePath(file.path))return false;
            const filename=path.join(root,file.path),info=await fs.lstat(filename);if(!info.isFile()||info.size!==file.size)return false;
            const hash=createHash('sha256');for await(const chunk of(await fs.open(filename,'r')).createReadStream())hash.update(chunk);
            if(hash.digest('hex')!==file.sha256)return false;
        }
        return receipt.entries.some((file:{path:string})=>file.path===entrypoint);
    } catch { return false; }
}
