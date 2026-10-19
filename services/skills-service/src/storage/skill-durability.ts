import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ServiceUnavailableException } from '@nestjs/common';
import { syncSkillDirectory } from './skill-versions';

interface ICommitPayload { id: string; changes: {relative: string}[]; }
export interface IUncertainSkillCommit {
    file: string;
    payload: ICommitPayload;
    checksum: string;
    allowMissing: boolean;
}
const uncertain = new Map<string, Map<string, IUncertainSkillCommit>>();
const deliveries = new Map<string, Promise<void>>();
const rootKey = (root: string): string => path.resolve(root);
const commitKey = (payload: ICommitPayload): string => payload.changes[0].relative.split('/')[0] + '\0' + payload.id;

function stable(value: unknown): string {
    if (Array.isArray(value)) { return '[' + value.map(stable).join(',') + ']'; }
    if (value && typeof value === 'object') {
        return '{' + Object.entries(value).sort(([left],[right])=>left.localeCompare(right)).map(([key,item])=>JSON.stringify(key)+':'+stable(item)).join(',') + '}';
    }
    return JSON.stringify(value);
}
const checksum = (payload: ICommitPayload): string => createHash('sha256').update(stable(payload)).digest('hex');

/** Видимость rename не подтверждает устойчивость записи при отказе fsync. */
export class SkillDurabilityUncertainException extends ServiceUnavailableException {
    constructor() {
        super({code:'SKILL_DURABILITY_UNCERTAIN',durability:{state:'uncertain'},
            message:'Изменения видны в файловой системе, но диск не подтвердил сохранение. Не повторяйте запись до восстановления готовности сервиса; затем перечитайте актуальные данные.'});
    }
}

export function assertSkillDurability(root: string): void {
    if (uncertain.get(rootKey(root))?.size) { throw new SkillDurabilityUncertainException(); }
}

export function uncertainSkillCommits(root: string): IUncertainSkillCommit[] {
    return [...(uncertain.get(rootKey(root))?.values() ?? [])];
}

export function markSkillDurabilityUncertain(root: string, file: string, payload: ICommitPayload, allowMissing = false): SkillDurabilityUncertainException {
    const key = rootKey(root);
    let records = uncertain.get(key);
    if (!records) { records = new Map(); uncertain.set(key,records); }
    const previous = records.get(commitKey(payload));
    records.set(commitKey(payload),{file,payload,checksum:previous?.checksum ?? checksum(payload),allowMissing});
    return new SkillDurabilityUncertainException();
}

/** Один UUID подтверждается/доставляется последовательно и между экземплярами хранилища. */
export async function withSkillCommit<T>(root: string, payload: ICommitPayload, work: () => Promise<T>): Promise<T> {
    const key = rootKey(root) + '\0' + commitKey(payload);
    const previous = deliveries.get(key) ?? Promise.resolve();
    let release!: () => void;
    const pending = new Promise<void>(resolve=>{release=resolve;});
    deliveries.set(key,pending);
    await previous;
    try { return await work(); }
    finally { release(); if (deliveries.get(key) === pending) { deliveries.delete(key); } }
}

/** Проверяет прежний payload и fsync файла/каталога до разрешения аудита или новых записей. */
export async function synchronizeSkillCommit(root: string, file: string, payload: ICommitPayload,
    decode: (raw: string) => ICommitPayload, allowMissing = false, releaseGate = true): Promise<void> {
    const key = rootKey(root);
    const id = commitKey(payload);
    const expected = uncertain.get(key)?.get(id)?.checksum ?? checksum(payload);
    try {
        const directory = path.dirname(file);
        const stat = await fs.lstat(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) { throw new Error('Повреждён каталог журнала скиллов.'); }
        let handle;
        try { handle = await fs.open(file,constants.O_RDONLY | constants.O_NOFOLLOW); }
        catch (error) { if (!allowMissing || (error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } }
        if (handle) {
            try {
                if (!(await handle.stat()).isFile() || checksum(decode(await handle.readFile('utf8'))) !== expected) {
                    throw new Error('Журнал скиллов изменился до подтверждения устойчивости.');
                }
                await handle.sync();
            } finally { await handle.close(); }
        }
        await syncSkillDirectory(directory);
        if (releaseGate) {
            const records = uncertain.get(key);
            records?.delete(id);
            if (records?.size === 0) { uncertain.delete(key); }
        }
    } catch { throw markSkillDurabilityUncertain(root,file,payload,allowMissing); }
}
