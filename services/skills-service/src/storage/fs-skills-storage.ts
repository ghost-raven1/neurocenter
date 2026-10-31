import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { isDeepStrictEqual } from 'node:util';
import { validateResources } from '../skills/skill-resources';
import { SKILL_VERSIONS_DIRECTORY, versionRelative, preserveVersion, syncSkillDirectory } from './skill-versions';

import type { ISkillFile, ISkillMeta, ISkillResource } from '../skills/skills.model';
import { normalizeMeta, parseSkillFile, serializeSkillFile } from './frontmatter';
import type { IStoredEntry, ISkillsStorage, ISkillChange, ISkillSourceReceipt } from './skills-storage.interface';
import {
    SKILL_JOURNAL_DIRECTORY,
    readSkillText,
    recoverSkillJournals,
    recoverSkillScope,
    withSkillJournal,
    withSkillScope,
} from './skill-journal';
import { reserveCapacity } from '../../../shared/capacity.cjs';
import { SkillAuditOutbox } from './skill-audit-outbox';
import {
    skillAuditEvents,
    skillDirectoryAuditEvents,
    type ISkillMutationContext,
    type TDeliverSkillAudit,
} from './skill-audit';
import {
    dependencyReservation,
    type ISkillDependencyReservation,
    type TReserveSkillDependencies,
} from './skill-dependency-reservation';
import { safeSkillDirectoryPath, skillDirectoryState, type ISkillDirectoryChange } from './skill-directory-change';
import { assertSkillDurability } from './skill-durability';

/** Журнал файла в корне использует компонент `имя.md`, каталоги — своё имя. */
const skillScope = (skillPath: string): string =>
    skillPath.includes('/') ? skillPath.split('/')[0] : skillPath + '.md';

/**
 * Хранилище скиллов на POSIX-томе (локальный каталог в dev).
 * Скилл — это `.md`-файл; базовый каталог задаётся параметром, доступ защищён от выхода за его пределы.
 */
export class FsSkillsStorage implements ISkillsStorage {
    readonly baseDir: string;

    private readonly auditOutbox: SkillAuditOutbox;
    public constructor(
        baseDir: string,
        private readonly reserveDependencies?: TReserveSkillDependencies,
        private readonly deliverAudit?: TDeliverSkillAudit,
    ) {
        this.baseDir = path.resolve(baseDir);
        this.auditOutbox = new SkillAuditOutbox(this.baseDir, deliverAudit);
    }

    public flushSkillAudit(): Promise<void> {
        return this.auditOutbox.flush();
    }
    public assertDurability(): void {
        assertSkillDurability(this.baseDir);
    }
    public pendingAudit(skillPath?: string, recursive = false): Promise<boolean> {
        this.assertDurability();
        return this.auditOutbox.pending(skillPath, recursive);
    }
    public onModuleDestroy(): Promise<void> {
        return this.auditOutbox.stop();
    }

    /** Все положительные ссылки фиксируются до публикации головы, истории или журнала. */
    private async reserveVersions(
        versions: { path: string; raw: string | null; purpose?: 'publish' | 'preserve' }[],
    ): Promise<void> {
        const unique = new Map<string, ISkillDependencyReservation>();
        for (const version of versions) {
            const entry =
                version.raw === null ? undefined : dependencyReservation(version.path, version.raw, version.purpose);
            if (!entry) {
                continue;
            }
            const key = entry.path + ':' + entry.key;
            // Публикация того же текста всегда строже сохранения, независимо от порядка пакета.
            if (!unique.has(key) || entry.purpose !== 'preserve') {
                unique.set(key, entry);
            }
        }
        if (unique.size && this.reserveDependencies) {
            await this.reserveDependencies([...unique.values()]);
        }
    }

    /**
     * Перевод относительного пути в абсолютный внутри базового каталога.
     *
     * @param {string} relPath - относительный путь
     * @returns {string} абсолютный путь внутри baseDir
     */
    private async toAbsolutePath(relPath: string): Promise<string> {
        const clean = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
        const absolute = path.resolve(this.baseDir, clean);

        if (absolute !== this.baseDir && !absolute.startsWith(this.baseDir + path.sep)) {
            throw new Error(`Путь вне базового каталога хранилища: ${relPath}`);
        }

        let base: string;
        try {
            base = await fs.realpath(this.baseDir);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw error;
            }
            base = this.baseDir;
        }
        let current = base;
        // Лексическая проверка не останавливает симлинк внутри доступной пользователю коллекции.
        for (const part of path.relative(this.baseDir, absolute).split(path.sep).filter(Boolean)) {
            current = path.join(current, part);
            try {
                if ((await fs.lstat(current)).isSymbolicLink()) {
                    throw new Error('Путь скилла содержит симлинк.');
                }
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                    throw error;
                }
            }
        }
        return current;
    }

    private skillFileAbsolute(skillPath: string): Promise<string> {
        return this.toAbsolutePath(skillPath + '.md');
    }

    public async init(): Promise<void> {
        await fs.mkdir(this.baseDir, { recursive: true });
        await recoverSkillJournals(this.baseDir, (changes) => this.reserveRecoveryVersions(changes));

        await this.auditOutbox.start();
    }

    public async isEmpty(): Promise<boolean> {
        try {
            const entries = await fs.readdir(this.baseDir);

            return (
                entries.filter((name) => name !== SKILL_JOURNAL_DIRECTORY && name !== SKILL_VERSIONS_DIRECTORY)
                    .length === 0
            );
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                return true;
            }
            throw error;
        }
    }

    public async existsSkill(skillPath: string): Promise<boolean> {
        return withSkillScope(this.baseDir, skillScope(skillPath), () => this.existsSkillCommitted(skillPath));
    }

    private async existsSkillCommitted(skillPath: string): Promise<boolean> {
        this.assertDurability();
        try {
            await fs.access(await this.skillFileAbsolute(skillPath));

            return true;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                return false;
            }
            throw error;
        }
    }

    private parse(raw: string, skillPath: string): ISkillFile {
        const { meta, body } = parseSkillFile(raw);
        if (!meta) {
            throw new Error(`У скилла отсутствует frontmatter: ${skillPath}`);
        }
        const resources = validateResources(meta.resources);
        return {
            path: skillPath,
            meta: normalizeMeta(meta, skillPath.slice(skillPath.lastIndexOf('/') + 1)),
            body,
            ...(resources.length ? { resources } : {}),
        };
    }

    public async readSkill(skillPath: string, version?: number): Promise<ISkillFile> {
        return withSkillScope(this.baseDir, skillScope(skillPath), () => this.readSkillCommitted(skillPath, version));
    }

    /** Exact raw file and resource bytes; a missing historical snapshot never falls back to the current head. */
    public sourceReceipt(skillPath: string, version?: number): Promise<ISkillSourceReceipt> {
        return withSkillScope(this.baseDir, skillScope(skillPath), async () => {
            this.assertDurability();
            const current = await this.readSkillCommitted(skillPath),
                file =
                    version === undefined || version === current.meta.version
                        ? await this.skillFileAbsolute(skillPath)
                        : await this.toAbsolutePath(versionRelative(skillPath, current.meta, version));
            const raw = await fs.readFile(file),
                parsed = this.parse(raw.toString('utf8'), skillPath);
            if (version !== undefined && parsed.meta.version !== version)
                throw new ConflictException('Исторический файл содержит другую версию.');
            return {
                version: parsed.meta.version,
                sha256: createHash('sha256').update(raw).digest('hex'),
                bytes: raw.length,
                resources: (parsed.resources ?? []).map((resource) => {
                    const bytes = Buffer.from(resource.content, resource.encoding === 'base64' ? 'base64' : 'utf8');
                    return {
                        path: resource.path,
                        bytes: bytes.length,
                        sha256: createHash('sha256').update(bytes).digest('hex'),
                    };
                }),
            };
        });
    }

    /** Чтение ждёт commit или rollback всей коллекции, включая запрос точного установочного пакета. */
    private async readSkillCommitted(skillPath: string, version?: number): Promise<ISkillFile> {
        this.assertDurability();
        const current = this.parse(await fs.readFile(await this.skillFileAbsolute(skillPath), 'utf8'), skillPath);
        if (version === undefined || version === current.meta.version) {
            return current;
        }
        if (!Number.isSafeInteger(version) || version < 1 || version > current.meta.version) {
            throw new NotFoundException('Эта версия скилла отсутствует в истории.');
        }
        try {
            const snapshot = this.parse(
                await fs.readFile(await this.toAbsolutePath(versionRelative(skillPath, current.meta, version)), 'utf8'),
                skillPath,
            );
            if (snapshot.meta.version !== version) {
                throw new Error('История версии повреждена.');
            }
            return snapshot;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                throw new NotFoundException('Содержимое старой версии не сохранено. Установите доступную версию.');
            }
            throw error;
        }
    }

    /** Закрепляет новые компоненты пути перед commit, включая каталог коллекции и поколения. */
    private async syncParents(directory: string): Promise<void> {
        let current = directory;
        while (current === this.baseDir || current.startsWith(this.baseDir + path.sep)) {
            await syncSkillDirectory(current);
            if (current === this.baseDir) {
                break;
            }
            current = path.dirname(current);
        }
    }

    private async preserveCurrent(skillPath: string, reserved = false): Promise<ISkillFile | undefined> {
        const raw = await readSkillText(await this.skillFileAbsolute(skillPath));
        if (raw === null) {
            return undefined;
        }
        const current = this.parse(raw, skillPath);
        if (!reserved) {
            await this.reserveVersions([{ path: skillPath, raw, purpose: 'preserve' }]);
        }
        const snapshot = await this.toAbsolutePath(versionRelative(skillPath, current.meta, current.meta.version));
        await preserveVersion(snapshot, raw);
        await this.syncParents(path.dirname(snapshot));
        return current;
    }

    public async writeSkill(
        skillPath: string,
        meta: ISkillMeta,
        body: string,
        resources?: ISkillResource[],
        context?: ISkillMutationContext,
        expected?: ISkillFile,
    ): Promise<void> {
        await withSkillScope(this.baseDir, skillScope(skillPath), async () => {
            this.assertDurability();
            await recoverSkillScope(this.baseDir, skillScope(skillPath), (entries) =>
                this.reserveRecoveryVersions(entries),
            );
            if (expected) {
                const raw = await readSkillText(await this.skillFileAbsolute(skillPath));
                if (raw === null || !isDeepStrictEqual(this.parse(raw, skillPath), expected)) {
                    throw new ConflictException('Скилл изменился после проверки. Обновите предварительный просмотр.');
                }
            }
            await this.applyChangesLocked(
                [{ path: skillPath, next: { path: skillPath, meta, body, resources } }],
                context,
                true,
            );
        });
        await this.auditOutbox.afterMutation();
    }

    private async writeSkillChecked(
        skillPath: string,
        meta: ISkillMeta,
        body: string,
        resources?: ISkillResource[],
        reserved = false,
    ): Promise<void> {
        const absolute = await this.skillFileAbsolute(skillPath);
        if (!reserved) {
            await this.reserveVersions([{ path: skillPath, raw: serializeSkillFile(meta, body, resources) }]);
        }
        const validated = validateResources(resources);
        const previous = await this.preserveCurrent(skillPath, reserved);
        if (previous && meta.version <= previous.meta.version) {
            if (
                JSON.stringify(previous.meta) === JSON.stringify(meta) &&
                previous.body === body &&
                JSON.stringify(previous.resources ?? []) === JSON.stringify(validated)
            ) {
                return;
            }
            throw new Error('Изменение скилла требует новой версии.');
        }

        await fs.mkdir(path.dirname(absolute), { recursive: true });
        await this.syncParents(path.dirname(absolute));
        const temporary = `${absolute}.${randomUUID()}.tmp`;
        try {
            if ((await this.skillFileAbsolute(skillPath)) !== absolute) {
                throw new Error('Каталог скилла изменился перед записью.');
            }
            await fs.writeFile(temporary, serializeSkillFile(meta, body, resources), { encoding: 'utf8', flag: 'wx' });
            if ((await this.skillFileAbsolute(skillPath)) !== absolute) {
                throw new Error('Каталог скилла изменился перед публикацией.');
            }
            const handle = await fs.open(temporary, 'r');
            try {
                await handle.sync();
            } finally {
                await handle.close();
            }
            if (previous) {
                await fs.rename(temporary, absolute);
            } else {
                await fs.link(temporary, absolute);
            }
            await syncSkillDirectory(path.dirname(absolute));
        } finally {
            await fs.rm(temporary, { force: true });
        }
    }

    /** Весь набор планируется под блокировкой коллекции и сохраняет исходные тексты до первой записи. */
    public async applySkillChanges(changes: ISkillChange[], context?: ISkillMutationContext): Promise<void> {
        if (!changes.length) {
            return;
        }
        const scope = skillScope(changes[0].path);
        if (changes.some((change) => skillScope(change.path) !== scope)) {
            throw new Error('Пакет скиллов должен принадлежать одной коллекции.');
        }
        await withSkillScope(this.baseDir, scope, async () => {
            this.assertDurability();
            await recoverSkillScope(this.baseDir, scope, (entries) => this.reserveRecoveryVersions(entries));
            await this.applyChangesLocked(changes, context);
        });
        await this.auditOutbox.afterMutation();
    }

    private async applyChangesLocked(
        changes: ISkillChange[],
        context?: ISkillMutationContext,
        single = false,
    ): Promise<void> {
        const planned = await Promise.all(
            changes.map(async (change) => ({
                change,
                entry: {
                    relative: change.path + '.md',
                    before: await readSkillText(await this.skillFileAbsolute(change.path)),
                    after: change.next
                        ? serializeSkillFile(change.next.meta, change.next.body, change.next.resources)
                        : null,
                },
            })),
        );
        // Входящий кандидат проверяется даже при повторяющемся пути; preserve не ослабляет publish.
        if (single) {
            if (changes[0].next) {
                await this.reserveVersions([{ path: changes[0].path, raw: planned[0].entry.after }]);
            }
        } else {
            await this.reserveJournalVersions(planned.map((item) => item.entry));
        }
        if (new Set(changes.map((change) => change.path)).size !== changes.length) {
            throw new Error('Пути в пакете скиллов не должны повторяться.');
        }
        const real = planned.filter((item) => item.entry.before !== item.entry.after);
        if (!real.length) {
            return;
        }
        const entries = real.map((item) => item.entry);
        // Для одиночной записи старая версия также резервируется до журнала.
        if (single) {
            await this.reserveVersions(
                entries.map((entry) => ({
                    path: entry.relative.slice(0, -3),
                    raw: entry.before,
                    purpose: 'preserve' as const,
                })),
            );
        }
        const events = this.deliverAudit
            ? skillAuditEvents(entries, context ?? { actor: 'skills-service', source: 'editor' })
            : undefined;
        await fs.mkdir(this.baseDir, { recursive: true });
        const release = await reserveCapacity({
            resource: 'skills',
            bytes: Buffer.byteLength(JSON.stringify({ entries, events }), 'utf8') * 4 + 65536,
            path: this.baseDir,
        });
        try {
            await withSkillJournal(
                this.baseDir,
                entries,
                async () => {
                    for (const { change } of real) {
                        if (change.next) {
                            await this.writeSkillChecked(
                                change.path,
                                change.next.meta,
                                change.next.body,
                                change.next.resources,
                                single,
                            );
                        } else {
                            await this.deleteSkillChecked(change.path, single);
                        }
                    }
                },
                (entries) => this.reserveRecoveryVersions(entries),
                events,
            );
        } finally {
            release();
        }
    }

    private async reserveJournalVersions(entries: import('./skill-journal').ISkillFileChange[]): Promise<void> {
        await this.reserveVersions(
            entries.flatMap((entry) => [
                { path: entry.relative.slice(0, -3), raw: entry.before, purpose: 'preserve' as const },
                { path: entry.relative.slice(0, -3), raw: entry.after, purpose: 'publish' as const },
            ]),
        );
    }

    /** Проверенный журнал восстанавливает прежний текст; новую версию при этом не публикуем. */
    private async reserveRecoveryVersions(entries: import('./skill-journal').ISkillFileChange[]): Promise<void> {
        await this.reserveVersions(
            entries.flatMap((entry) =>
                [entry.before, entry.after].map((raw) => ({
                    path: entry.relative.slice(0, -3),
                    raw,
                    purpose: 'preserve' as const,
                })),
            ),
        );
    }

    /** Исключительное создание проверяется под той же блокировкой, что и журнал коллекции. */
    public async createSkill(
        skillPath: string,
        meta: ISkillMeta,
        body: string,
        resources?: ISkillResource[],
        context?: ISkillMutationContext,
    ): Promise<boolean> {
        const created = await withSkillScope(this.baseDir, skillScope(skillPath), async () => {
            this.assertDurability();
            await recoverSkillScope(this.baseDir, skillScope(skillPath), (entries) =>
                this.reserveRecoveryVersions(entries),
            );
            if (await this.existsSkillCommitted(skillPath)) {
                return false;
            }
            await this.applyChangesLocked(
                [{ path: skillPath, next: { path: skillPath, meta, body, resources } }],
                context,
                true,
            );
            return true;
        });
        await this.auditOutbox.afterMutation();
        return created;
    }

    public async deleteSkill(skillPath: string, context?: ISkillMutationContext): Promise<void> {
        await withSkillScope(this.baseDir, skillScope(skillPath), async () => {
            this.assertDurability();
            await recoverSkillScope(this.baseDir, skillScope(skillPath), (entries) =>
                this.reserveRecoveryVersions(entries),
            );
            await this.applyChangesLocked([{ path: skillPath, next: null }], context, true);
        });
        await this.auditOutbox.afterMutation();
    }

    private async deleteSkillChecked(skillPath: string, reserved = false): Promise<void> {
        await this.preserveCurrent(skillPath, reserved);
        const absolute = await this.skillFileAbsolute(skillPath);
        await fs.rm(absolute, { force: true });
        await syncSkillDirectory(path.dirname(absolute));
    }

    public async makeDirectory(dirPath: string, context?: ISkillMutationContext): Promise<void> {
        if (!safeSkillDirectoryPath(dirPath)) {
            throw new Error('Недопустимый путь папки скиллов.');
        }
        await withSkillScope(this.baseDir, dirPath.split('/')[0], async () => {
            this.assertDurability();
            await recoverSkillScope(this.baseDir, dirPath.split('/')[0], (entries) =>
                this.reserveRecoveryVersions(entries),
            );
            const parts = dirPath.split('/');
            const createdDirectories: string[] = [];
            for (let index = 0; index < parts.length; index++) {
                const relative = parts.slice(0, index + 1).join('/');
                if ((await skillDirectoryState(await this.toAbsolutePath(relative))) === null) {
                    createdDirectories.push(relative);
                }
            }
            if (!createdDirectories.length) {
                return;
            }
            const change: ISkillDirectoryChange = {
                kind: 'directory',
                relative: dirPath,
                before: null,
                after: 'directory',
                createdDirectories,
            };
            const events = this.deliverAudit
                ? skillDirectoryAuditEvents(dirPath, context?.actor ?? 'skills-service')
                : undefined;
            await fs.mkdir(this.baseDir, { recursive: true });
            const release = await reserveCapacity({
                resource: 'skills',
                bytes: Buffer.byteLength(JSON.stringify({ change, events }), 'utf8') * 4 + 65536,
                path: this.baseDir,
            });
            try {
                await withSkillJournal(
                    this.baseDir,
                    [change],
                    async () => {
                        for (const relative of createdDirectories) {
                            const absolute = await this.toAbsolutePath(relative);
                            await fs.mkdir(absolute);
                            await syncSkillDirectory(absolute);
                            await syncSkillDirectory(path.dirname(absolute));
                        }
                    },
                    undefined,
                    events,
                );
            } finally {
                release();
            }
        });
        await this.auditOutbox.afterMutation();
    }

    public async listDir(dirPath: string): Promise<IStoredEntry[]> {
        if (dirPath) {
            return withSkillScope(this.baseDir, dirPath.split('/')[0], () => this.listDirCommitted(dirPath));
        }
        const entries = await this.listDirCommitted('');
        const committed = await Promise.all(
            entries.map((entry) =>
                !entry.isDir
                    ? entry
                    : withSkillScope(this.baseDir, entry.name, async () => {
                          this.assertDurability();
                          return (await skillDirectoryState(await this.toAbsolutePath(entry.name))) === 'directory'
                              ? entry
                              : undefined;
                      }),
            ),
        );
        return committed.filter((entry): entry is IStoredEntry => entry !== undefined);
    }

    private async listDirCommitted(dirPath: string): Promise<IStoredEntry[]> {
        this.assertDurability();
        let entries;

        try {
            entries = await fs.readdir(await this.toAbsolutePath(dirPath), { withFileTypes: true });
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                return [];
            }
            throw error;
        }

        return entries
            .filter(
                (entry) =>
                    entry.name !== SKILL_JOURNAL_DIRECTORY &&
                    entry.name !== SKILL_VERSIONS_DIRECTORY &&
                    (entry.isDirectory() || (entry.isFile() && entry.name.endsWith('.md'))),
            )
            .map((entry) => ({ name: entry.name, isDir: entry.isDirectory() }))
            .sort((left, right) =>
                left.isDir === right.isDir ? left.name.localeCompare(right.name) : left.isDir ? -1 : 1,
            );
    }
}
