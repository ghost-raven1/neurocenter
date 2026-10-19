import fs from 'node:fs/promises';
import { safeTarget } from './workspace.js';
import { fileFingerprint, readBoundedSnapshot } from './read-bounded.js';
import { hash } from './state.js';
import type { InventorySnapshot } from './project-inventory.model.js';

export const inventoryRelative = (value: string): boolean => typeof value === 'string' && value.length > 0 && value.length <= 1024
    && !value.includes('\\') && !value.startsWith('/') && value.split('/').every(part => !!part && part !== '.' && part !== '..'
        && !/[<>:"|?*\x00-\x1f]/.test(part) && !/[. ]$/.test(part) && !/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(part));
export class InventoryReadError extends Error {
    constructor(readonly reason: 'unsafe-path' | 'read-limit' | 'read-failed' | 'snapshot-changed') { super(reason); }
}
/** Ограниченный снимок включает списки папок: новый соседний файл также отменяет принятие. */
export class InventoryReader {
    private readonly snapshots = new Map<string, InventorySnapshot>();
    private bytes = 0;
    constructor(readonly root: string) {}
    private async target(relative: string): Promise<string> {
        if (!inventoryRelative(relative)) { throw new InventoryReadError('unsafe-path'); }
        try { return await safeTarget(this.root, relative); } catch { throw new InventoryReadError('unsafe-path'); }
    }
    private remember(item: InventorySnapshot): void {
        if (this.snapshots.size >= 2000 && !this.snapshots.has(item.relative)) { throw new InventoryReadError('read-limit'); }
        const before = this.snapshots.get(item.relative);
        if (before && JSON.stringify(before) !== JSON.stringify(item)) { throw new InventoryReadError('snapshot-changed'); }
        this.snapshots.set(item.relative, item);
    }
    async read(relative: string, maximum = 1048576): Promise<Buffer | null> {
        const file = await this.target(relative);
        try {
            const before = await fs.lstat(file, { bigint: true });
            if (!before.isFile() || before.isSymbolicLink()) { throw new InventoryReadError('unsafe-path'); }
            if (before.size > maximum || this.bytes + Number(before.size) > 64 * 1048576) { throw new InventoryReadError('read-limit'); }
            const snapshot = await readBoundedSnapshot(file, maximum); await this.target(relative);
            this.bytes += snapshot.bytes.length;
            this.remember({ relative, type: 'file', fingerprint: snapshot.fingerprint, sha256: hash(snapshot.bytes) });
            return snapshot.bytes;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                this.remember({ relative, type: 'file', fingerprint: null, sha256: null }); return null;
            }
            if (error instanceof InventoryReadError) { throw error; }
            throw new InventoryReadError((error as NodeJS.ErrnoException).code === 'ESTALE' ? 'snapshot-changed' : 'read-failed');
        }
    }
    async list(relative: string): Promise<string[] | null> {
        const target = await this.target(relative); let existed = false;
        try {
            const before = await fs.lstat(target, { bigint: true }); existed = true;
            if (!before.isDirectory() || before.isSymbolicLink()) { throw new InventoryReadError('unsafe-path'); }
            const names: string[] = [];
            for await (const item of await fs.opendir(target)) {
                if (names.length >= 2000) { throw new InventoryReadError('read-limit'); }
                if (!inventoryRelative(item.name)) { throw new InventoryReadError('unsafe-path'); }
                names.push(item.name);
            }
            await this.target(relative);
            if (fileFingerprint(await fs.lstat(target, { bigint: true })) !== fileFingerprint(before)) { throw new InventoryReadError('snapshot-changed'); }
            names.sort(); this.remember({ relative, type: 'directory', fingerprint: fileFingerprint(before), sha256: hash(JSON.stringify(names)) });
            return names;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                if (existed) { throw new InventoryReadError('snapshot-changed'); }
                this.remember({ relative, type: 'directory', fingerprint: null, sha256: null }); return null;
            }
            if (error instanceof InventoryReadError) { throw error; }
            throw new InventoryReadError('read-failed');
        }
    }
    async tree(relative: string, depth = 0): Promise<string[]> {
        if (depth > 32) { throw new InventoryReadError('read-limit'); }
        const names = await this.list(relative); if (names === null) { return []; }
        const files: string[] = [];
        for (const name of names) {
            const child = relative + '/' + name;
            const stat = await fs.lstat(await this.target(child));
            if (stat.isDirectory()) { files.push(...await this.tree(child, depth + 1)); }
            else { if (await this.read(child) === null) { throw new InventoryReadError('snapshot-changed'); } files.push(child); }
            if (files.length > 2000) { throw new InventoryReadError('read-limit'); }
        }
        return files;
    }
    values(): InventorySnapshot[] { return [...this.snapshots.values()].sort((a, b) => a.relative < b.relative ? -1 : 1); }
    async verify(snapshots = this.values()): Promise<void> {
        const fresh = new InventoryReader(this.root);
        for (const item of snapshots) { if (item.type === 'directory') { await fresh.list(item.relative); } else { await fresh.read(item.relative, item.relative.endsWith('/installations.json') ? 4 * 1048576 : 1048576); } }
        if (JSON.stringify(fresh.values()) !== JSON.stringify([...snapshots].sort((a, b) => a.relative < b.relative ? -1 : 1))) { throw new InventoryReadError('snapshot-changed'); }
    }
}
