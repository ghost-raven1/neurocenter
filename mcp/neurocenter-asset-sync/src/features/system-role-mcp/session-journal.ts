import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { hash } from '../../bridge/state.js';
import { atomicText, syncDirectory } from '../../bridge/atomic-file.js';
import { readBoundedSnapshot } from '../../bridge/read-bounded.js';
import { assertPrivateWindowsAcl, enforcePrivateWindowsAcl } from '../local-configuration/private-store.js';
import type { RoleMcpIdentity } from './api.js';
import type { SessionJob } from './worker.js';

export interface RoleMcpOwner {
    pid: number;
    uid: number;
    birth: string;
    entry: string;
}
export interface RoleMcpCompletion {
    jobId: string;
    lease: string;
    state: 'succeeded' | 'failed';
    message: string;
    result: { schemaVersion: 1; sessionId: string; closed: true };
}
type Scope = Omit<RoleMcpIdentity, 'profile'>;
export interface RoleMcpSessionIntent {
    schemaVersion: 1;
    requestId: string;
    nonce: string;
    identity: Scope;
    owner: RoleMcpOwner;
    phase: 'pending' | 'claimed' | 'closed';
    job?: SessionJob;
    stdio?: RoleMcpOwner;
    completion?: RoleMcpCompletion;
}
const uuid = (value: unknown): value is string =>
    typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const maximum = 200;
const scope = ({ profile: _, ...identity }: RoleMcpIdentity) => identity;
const owner = (value: RoleMcpOwner) =>
    value &&
    Number.isSafeInteger(value.pid) &&
    value.pid > 1 &&
    Number.isSafeInteger(value.uid) &&
    typeof value.birth === 'string' &&
    !!value.birth &&
    value.birth.length <= 256 &&
    typeof value.entry === 'string' &&
    path.isAbsolute(value.entry) &&
    value.entry.length <= 4096;

/** Only this admitted physical profile can contain or retire its session ownership records. */
export async function sessionDirectory(
    identity: RoleMcpIdentity,
    kind:
        | 'system-role-mcp-sessions'
        | 'system-role-mcp-work'
        | 'system-role-mcp-closed-archive'
        | 'system-role-mcp-receipts' = 'system-role-mcp-sessions',
) {
    const parent = await fs.lstat(identity.profile, { bigint: true });
    if (
        !parent.isDirectory() ||
        parent.isSymbolicLink() ||
        hash(identity.profile + '\0' + parent.dev + '\0' + parent.ino + '\0' + parent.birthtimeNs) !==
            identity.profileKey ||
        (process.platform !== 'win32' && (parent.uid !== BigInt(process.getuid!()) || (parent.mode & 0o077n) !== 0n))
    )
        throw new Error('Профиль владельца сессии MCP изменился.');
    const directory = path.join(identity.profile, kind);
    try {
        await fs.mkdir(directory, { mode: 0o700 });
        await enforcePrivateWindowsAcl(directory, true);
        await syncDirectory(identity.profile);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const info = await fs.lstat(directory);
    if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        (process.platform !== 'win32' && (info.uid !== process.getuid!() || (info.mode & 0o077) !== 0))
    )
        throw new Error('Небезопасный каталог сессий MCP.');
    await assertPrivateWindowsAcl(directory);
    return directory;
}
function validate(value: unknown): RoleMcpSessionIntent {
    const item = value as RoleMcpSessionIntent,
        keys = [
            'schemaVersion',
            'requestId',
            'nonce',
            'identity',
            'owner',
            'phase',
            ...(item?.job ? ['job'] : []),
            ...(item?.stdio ? ['stdio'] : []),
            ...(item?.completion ? ['completion'] : []),
        ];
    if (
        !item ||
        Object.keys(item).sort().join(',') !== keys.sort().join(',') ||
        item.schemaVersion !== 1 ||
        !uuid(item.requestId) ||
        !uuid(item.nonce) ||
        !owner(item.owner) ||
        !item.identity ||
        Object.keys(item.identity).sort().join(',') !== 'apiUrl,credentialHash,deviceId,profileKey,siteUrl' ||
        !uuid(item.identity.deviceId) ||
        !digest(item.identity.profileKey) ||
        !digest(item.identity.credentialHash) ||
        !['pending', 'claimed', 'closed'].includes(item.phase)
    )
        throw new Error('Повреждён журнал владельца MCP.');
    for (const origin of [item.identity.siteUrl, item.identity.apiUrl]) {
        const url = new URL(origin);
        if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin || url.username || url.password)
            throw new Error('Повреждена площадка журнала MCP.');
    }
    if (item.stdio && !owner(item.stdio)) throw new Error('Повреждён владелец процесса MCP.');
    if (
        item.job &&
        (!uuid(item.job.id) ||
            !uuid(item.job.lease) ||
            item.job.payload?.sessionId !== item.job.id ||
            item.job.requestId !== item.requestId)
    )
        throw new Error('Повреждена аренда журнала MCP.');
    if (
        (item.phase === 'pending' && (item.job || item.stdio || item.completion)) ||
        (item.phase === 'claimed' && (!item.job || item.completion)) ||
        (item.phase === 'closed' && (!item.job || !item.completion))
    )
        throw new Error('Повреждён переход журнала MCP.');
    if (item.completion) completion(item.job!, item.completion);
    return item;
}
function completion(job: SessionJob, value: unknown): RoleMcpCompletion {
    const result = value as RoleMcpCompletion;
    if (
        !result ||
        Object.keys(result).sort().join(',') !== 'jobId,lease,message,result,state' ||
        result.jobId !== job.id ||
        result.lease !== job.lease ||
        !['succeeded', 'failed'].includes(result.state) ||
        typeof result.message !== 'string' ||
        Buffer.byteLength(result.message) > 2048 ||
        result.message.includes('\0') ||
        !result.result ||
        Object.keys(result.result).sort().join(',') !== 'closed,schemaVersion,sessionId' ||
        result.result.schemaVersion !== 1 ||
        result.result.sessionId !== job.id ||
        result.result.closed !== true
    )
        throw new Error('Нужно точное подтверждение очистки этой сессии MCP.');
    return structuredClone(result);
}
function sameScope(identity: RoleMcpIdentity, item: RoleMcpSessionIntent) {
    return Object.entries(scope(identity)).every(([key, value]) => item.identity[key as keyof Scope] === value);
}
async function snapshot(identity: RoleMcpIdentity, requestId: string) {
    if (!uuid(requestId)) throw new Error('Некорректный запрос сессии MCP.');
    const file = path.join(await sessionDirectory(identity), requestId + '.json');
    const info = await fs.lstat(file);
    if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.nlink !== 1 ||
        (process.platform !== 'win32' && (info.uid !== process.getuid!() || (info.mode & 0o077) !== 0))
    )
        throw new Error('Небезопасная запись журнала MCP.');
    await assertPrivateWindowsAcl(file);
    const before = await readBoundedSnapshot(file, 16384),
        item = validate(JSON.parse(before.bytes.toString('utf8')));
    if (item.requestId !== requestId) throw new Error('Запрос журнала MCP изменился.');
    return { file, before, item };
}
export async function readRoleMcpIntents(identity: RoleMcpIdentity): Promise<RoleMcpSessionIntent[]> {
    const directory = await sessionDirectory(identity),
        items: RoleMcpSessionIntent[] = [];
    let count = 0;
    for await (const entry of await fs.opendir(directory)) {
        if (!entry.name.endsWith('.json')) continue;
        if (++count > maximum || !uuid(entry.name.slice(0, -5)))
            throw new Error('Доставьте сохранённые завершения MCP перед новыми действиями.');
        const { item } = await snapshot(identity, entry.name.slice(0, -5));
        // A different connection cannot silently adopt or overwrite an outstanding worker.
        if (!sameScope(identity, item)) {
            if (item.phase !== 'closed')
                throw new Error('Сначала завершите восстановление MCP для прежнего подключения.');
            await archiveClosed(identity, item);
            continue;
        }
        items.push(item);
    }
    return items;
}
/** A lost ACK followed by token renewal preserves the closed proof without sending it with the new token. */
async function archiveClosed(identity: RoleMcpIdentity, item: RoleMcpSessionIntent) {
    const current = await snapshot(identity, item.requestId),
        directory = await sessionDirectory(identity, 'system-role-mcp-closed-archive'),
        destination = path.join(directory, item.requestId + '.json');
    if (current.item.phase !== 'closed' || JSON.stringify(current.item) !== JSON.stringify(item))
        throw new Error('Подтверждение очистки MCP изменилось перед архивированием.');
    try {
        const existing = await readBoundedSnapshot(destination, 16384);
        if (!existing.bytes.equals(current.before.bytes))
            throw new Error('Архив подтверждения MCP уже содержит другие данные.');
        await fs.unlink(current.file);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await fs.rename(current.file, destination);
    }
    await syncDirectory(directory);
    await syncDirectory(path.dirname(current.file));
}
/** Persist before the first claim request; a recovery request must never allocate a new tool session. */
export async function beginRoleMcpIntent(identity: RoleMcpIdentity, worker: RoleMcpOwner) {
    if ((await readRoleMcpIntents(identity)).length >= maximum)
        throw new Error('Доставьте сохранённые завершения MCP перед новыми действиями.');
    const item = validate({
        schemaVersion: 1,
        requestId: randomUUID(),
        nonce: randomUUID(),
        identity: scope(identity),
        owner: worker,
        phase: 'pending',
    });
    await atomicText(
        path.join(await sessionDirectory(identity), item.requestId + '.json'),
        JSON.stringify(item),
        0o600,
    );
    return item;
}
async function change(identity: RoleMcpIdentity, item: RoleMcpSessionIntent, next: RoleMcpSessionIntent) {
    const current = await snapshot(identity, item.requestId);
    if (!sameScope(identity, current.item) || JSON.stringify(current.item) !== JSON.stringify(item))
        throw new Error('Журнал MCP изменился во время выполнения.');
    validate(next);
    await atomicText(current.file, JSON.stringify(next), 0o600);
    return next;
}
export async function retainRoleMcpClaim(identity: RoleMcpIdentity, item: RoleMcpSessionIntent, job: SessionJob) {
    if (item.phase !== 'pending' || job.requestId !== item.requestId)
        throw new Error('Подтверждение относится к другому запросу MCP.');
    const exact: SessionJob = {
        id: job.id,
        lease: job.lease,
        project_id: job.project_id,
        payload: { sessionId: job.payload.sessionId },
        requestId: job.requestId,
        ...(job.recoveryOnly ? { recoveryOnly: true } : {}),
    };
    return change(identity, item, { ...item, phase: 'claimed', job: exact });
}
export async function retainRoleMcpStdio(identity: RoleMcpIdentity, item: RoleMcpSessionIntent, process: RoleMcpOwner) {
    if (item.phase !== 'claimed' || item.stdio) throw new Error('Процесс MCP уже зафиксирован.');
    return change(identity, item, { ...item, stdio: process });
}
/** Called only after awaited local process, transport and private HOME cleanup. */
export async function retainRoleMcpCompletion(identity: RoleMcpIdentity, item: RoleMcpSessionIntent, value: unknown) {
    if (!item.job || item.phase !== 'claimed') throw new Error('Сессия MCP не подтверждена.');
    return change(identity, item, { ...item, phase: 'closed', completion: completion(item.job, value) });
}
/** Confirmed success retires exactly these bytes; a conflicting replacement stays available for recovery. */
export async function retireRoleMcpIntent(identity: RoleMcpIdentity, item: RoleMcpSessionIntent) {
    const current = await snapshot(identity, item.requestId);
    if (!sameScope(identity, current.item) || JSON.stringify(current.item) !== JSON.stringify(item))
        throw new Error('Подтверждение MCP изменилось перед очисткой.');
    const actual = await readBoundedSnapshot(current.file, 16384);
    if (actual.fingerprint !== current.before.fingerprint || !actual.bytes.equals(current.before.bytes))
        throw new Error('Журнал MCP заменён перед очисткой.');
    await fs.unlink(current.file);
    await syncDirectory(path.dirname(current.file));
}
export const roleMcpIntentMatches = sameScope;
