import fs from 'node:fs/promises';
import path from 'node:path';
import { hash, stateDir } from './state.js';
import { atomicText } from './atomic-file.js';
import { recoveryDirectory } from './installation-space.js';
import { readBoundedUtf8 } from './read-bounded.js';
import type { Journal } from './installation-journal.js';

export interface RecoveryIndex {
    schemaVersion: 1;
    recoveryId: string;
    assetKey: string;
    createdAt: string;
    journalRoot: string;
    journalSha256: string;
}
export const variantIndexDirectory = (instanceId: string): string =>
    path.join(stateDir(), 'file-changes', hash('local-variants:' + instanceId), 'history');
export function recoveryIndexRecord(journal: Journal): RecoveryIndex {
    if (!journal.recovery) {
        throw new Error('Нет описания резервной копии.');
    }
    return {
        schemaVersion: 1,
        recoveryId: journal.id,
        assetKey: journal.assetKey,
        createdAt: journal.recovery.createdAt,
        journalRoot: journal.root,
        journalSha256: hash(JSON.stringify(journal)),
    };
}

/** Индекс не содержит исходников; его размер входит в существующую квоту истории. */
export async function indexLocalRecovery(journal: Journal): Promise<void> {
    if (!journal.recovery || journal.state !== 'committed' || journal.action !== 'install') {
        return;
    }
    const directory = variantIndexDirectory(journal.recovery.instanceId);
    await recoveryDirectory(directory);
    const value = recoveryIndexRecord(journal);
    const destination = path.join(directory, journal.assetKey + '-' + journal.id + '.index.json');
    const text = JSON.stringify(value);
    const previous = await fs.lstat(destination).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') {
            return null;
        }
        throw error;
    });
    if (previous) {
        if ((await readBoundedUtf8(destination, 16384)) !== text) {
            throw new Error('Индекс резервной копии изменён.');
        }
        return;
    }
    await atomicText(destination, text, 0o600);
}
