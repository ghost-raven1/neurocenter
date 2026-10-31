import { resolvePreparedRuntimeArtifact } from '../features/runtime-artifacts/cache.js';
import type { Package } from './package.js';
import { safeTarget } from './workspace.js';
import type { FileChange } from './installation-files.js';
import { readBoundedSnapshot } from './read-bounded.js';
import { installationReadLimit } from './installation-limits.js';
import { hash } from './state.js';

interface PlannedFile {
    before: Buffer | null;
    after: Buffer | null;
    fingerprint: string | null;
    encoding?: 'base64';
}
export interface SnapshotFingerprint {
    relative: string;
    fingerprint: string | null;
    sha256: string | null;
}

/** Общий снимок файлов объединяет несколько правок JSONC в единственную запись журнала. */
export class InstallationPlan {
    private readonly files = new Map<string, PlannedFile>();
    private readonly writes = new Set<string>();
    private readonly runtimePackages = new Map<string, Package>();
    /** Повторно проверяет одобренные байты внешнего неизменяемого комплекта перед commit. */
    expectRuntimeArtifact(pkg: Package): void {
        if (pkg.config?.extra?.runtimeArtifacts) {
            this.runtimePackages.set(pkg.manifest.sha256, structuredClone(pkg));
        }
    }
    constructor(readonly root: string) {}
    async read(relative: string, encoding: 'utf8' | 'base64' = 'utf8'): Promise<string | null> {
        let file = this.files.get(relative);
        if (!file) {
            const target = await safeTarget(this.root, relative);
            const snapshot = await readBoundedSnapshot(target, installationReadLimit(relative)).catch(
                (error: NodeJS.ErrnoException) => {
                    if (error.code === 'ENOENT') {
                        return null;
                    }
                    throw error;
                },
            );
            await safeTarget(this.root, relative);
            const before = snapshot?.bytes ?? null;
            file = { before, after: before, fingerprint: snapshot?.fingerprint ?? null };
            this.files.set(relative, file);
        }
        const text = file.after?.toString(encoding) ?? null;
        if (encoding === 'utf8' && text !== null && !Buffer.from(text).equals(file.after!)) {
            throw new Error('Некорректное кодирование локального JSON.');
        }
        return text;
    }
    async write(relative: string, text: string | null, encoding: 'utf8' | 'base64' = 'utf8'): Promise<void> {
        await this.read(relative, encoding);
        const file = this.files.get(relative)!;
        const bytes = text === null ? null : Buffer.from(text, encoding);
        if (bytes && bytes.length > installationReadLimit(relative)) {
            throw new Error('Файл превышает допустимый размер локальной записи.');
        }
        file.after = bytes;
        if (encoding === 'base64') {
            file.encoding = 'base64';
        }
        this.writes.add(relative);
    }
    async verifySnapshot(): Promise<void> {
        for (const pkg of this.runtimePackages.values()) {
            await resolvePreparedRuntimeArtifact(pkg);
        }
        for (const [relative, file] of this.files) {
            const current = await readBoundedSnapshot(
                await safeTarget(this.root, relative),
                installationReadLimit(relative),
            ).catch((error: NodeJS.ErrnoException) => {
                if (error.code === 'ENOENT') {
                    return null;
                }
                throw error;
            });
            await safeTarget(this.root, relative);
            if (
                current === null
                    ? file.before !== null
                    : file.before === null ||
                      current.fingerprint !== file.fingerprint ||
                      !current.bytes.equals(file.before)
            ) {
                throw new Error('Файл изменился во время подготовки набора: ' + relative);
            }
        }
    }
    changes(): FileChange[] {
        return [...this.writes]
            .map((relative) => [relative, this.files.get(relative)!] as const)
            .filter(([, file]) =>
                file.before === null ? file.after !== null : file.after === null || !file.before.equals(file.after),
            )
            .map(([relative, file]) => ({
                relative,
                before: file.before?.toString(file.encoding ?? 'utf8') ?? null,
                after: file.after?.toString(file.encoding ?? 'utf8') ?? null,
                beforeFingerprint: file.fingerprint,
                ...(file.encoding ? { encoding: file.encoding } : {}),
            }));
    }
    /** Неизменяемые метаданные всех чтений защищают также ledger и соседние настройки. */
    snapshotFingerprints(): SnapshotFingerprint[] {
        return [...this.files].map(([relative, file]) => ({
            relative,
            fingerprint: file.fingerprint,
            sha256: file.before === null ? null : hash(file.before),
        }));
    }
}
