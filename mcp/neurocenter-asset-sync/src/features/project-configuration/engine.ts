import { extractFrontmatter } from '../../lib/frontmatter.js';
import { randomUUID } from 'node:crypto';
import { hash, jobContext } from '../../bridge/state.js';
import { InstallationPlan } from '../../bridge/installation-plan.js';
import { withProjectFiles, commitChanges } from '../../bridge/installation-files.js';
import type { ConfigurationContext, Authorize } from './context.js';
import { discoverFiles, MAX_TEXT_BYTES, type ConfigurationFile } from './discovery.js';
import { agentSection } from './agents.js';
import {
    managedProtection,
    provenRag,
    assertManualFile,
    preserveConnections,
    hasManagedRagProfile,
} from './ownership.js';
import { configurationObject, ragFields, preserveRagProfile, updateRagFields } from './json.js';
export const conflict = () =>
    Object.assign(
        Error('Файлы изменились после открытия или предпросмотра. Скопируйте черновик и откройте файл заново.'),
        { code: 'PROJECT_CONFIGURATION_CONFLICT' },
    );
interface OpenFile {
    file: ConfigurationFile;
    plan: InstallationPlan;
    before: string | null;
    revision: string;
}
interface Preview extends OpenFile {
    after: string;
    digest: string;
    previewId: string;
}
/** Session snapshots and previews stay only in local memory; writes use the existing CAS journal. */
export class ConfigurationEditor {
    private files: ConfigurationFile[] = [];
    private opened?: OpenFile;
    private preview?: Preview;
    constructor(
        readonly context: ConfigurationContext,
        private readonly authorize: Authorize,
        private readonly current: () => void = () => {},
    ) {}
    private async admit() {
        this.current();
        await this.context.assertCurrent();
        await this.authorize();
        this.current();
        await this.context.assertCurrent();
    }
    async inventory() {
        await this.admit();
        const plan = new InstallationPlan(this.context.root),
            rag = await provenRag(this.context, plan),
            discovery = await discoverFiles(this.context.root, plan, rag),
            protection = await managedProtection(this.context, plan);
        this.files = discovery.files.map((file) => ({
            ...file,
            readonly: file.readonly || protection.files.has(file.path),
        }));
        await plan.verifySnapshot();
        await this.admit();
        return {
            files: this.files,
            limited: discovery.limited,
            ragAvailable: rag,
            expiresAt: this.context.descriptor.expiresAt,
        };
    }
    async read(relative: unknown) {
        await this.admit();
        const file = this.files.find((item) => item.path === relative);
        if (!file) throw Error('Выберите файл из списка проекта.');
        const plan = new InstallationPlan(this.context.root),
            before = await plan.read(file.path);
        if (before !== null && Buffer.byteLength(before) > MAX_TEXT_BYTES) throw Error('Файл превышает 256 КиБ.');
        const revision = hash(JSON.stringify([file.path, before, plan.snapshotFingerprints()]));
        this.opened = { file, plan, before, revision };
        this.preview = undefined;
        await this.admit();
        return {
            file,
            content: before ?? '',
            revision,
            ...(file.kind === 'rag'
                ? {
                      rag: ragFields(configurationObject(before, true)),
                      managedProfile: await hasManagedRagProfile(this.context),
                  }
                : {}),
        };
    }
    async prepare(input: {
        path?: unknown;
        revision?: unknown;
        text?: unknown;
        rag?: unknown;
        agentSection?: unknown;
        draft?: unknown;
    }) {
        await this.admit();
        const opened = this.opened;
        if (!opened || input.path !== opened.file.path || input.revision !== opened.revision) throw conflict();
        const plan = opened.plan;
        await plan.verifySnapshot();
        const protection = await managedProtection(this.context, plan);
        assertManualFile(opened.file.path, protection);
        const modes = [input.text !== undefined, input.rag !== undefined, input.agentSection !== undefined].filter(
            Boolean,
        ).length;
        if (modes !== 1) throw Error('Выберите одно изменение для предпросмотра.');
        let after: string;
        if (input.agentSection !== undefined) {
            if (input.agentSection !== true || opened.file.path !== 'AGENTS.md')
                throw Error('Раздел агентов доступен в корневом AGENTS.md.');
            after = await agentSection(
                this.context,
                plan,
                typeof input.draft === 'string' ? input.draft : opened.before,
            );
        } else if (input.rag !== undefined) {
            if (opened.file.kind !== 'rag' || !(await provenRag(this.context, plan)))
                throw Error('RAG не подтверждён в этой папке.');
            after = updateRagFields(opened.before, input.rag);
        } else {
            if (typeof input.text !== 'string') throw Error('Нужен текст файла.');
            after = input.text;
        }
        if (
            Buffer.byteLength(after) > MAX_TEXT_BYTES ||
            after.includes('\0') ||
            Buffer.from(after).toString('utf8') !== after
        )
            throw Error('Текст превышает 256 КиБ или содержит нулевой байт.');
        if (opened.file.kind === 'markdown' && /^\.opencode\/(agents?|modes?)\//.test(opened.file.path)) {
            const alias = extractFrontmatter(after)?.name;
            if (typeof alias === 'string' && /^nc-/i.test(alias))
                throw Error('Управляемые агенты и подключения изменяются через сайт. Имя nc-* зарезервировано.');
        }
        if (opened.file.kind === 'opencode')
            await preserveConnections(plan, opened.file.path, opened.before, after, protection);
        if (opened.file.kind === 'rag') {
            if (!(await provenRag(this.context, plan))) throw Error('RAG больше не подтверждён.');
            preserveRagProfile(
                configurationObject(opened.before, true),
                configurationObject(after, true),
                await hasManagedRagProfile(this.context),
            );
        }
        await plan.verifySnapshot();
        await this.admit();
        const digest = hash(JSON.stringify([opened.revision, after, plan.snapshotFingerprints()])),
            previewId = randomUUID();
        this.preview = { ...opened, after, digest, previewId };
        return {
            previewId,
            digest,
            path: opened.file.path,
            before: opened.before ?? '',
            after,
            created: opened.before === null,
            changed: opened.before !== after,
        };
    }
    async save(input: { previewId?: unknown; digest?: unknown }) {
        await this.admit();
        const preview = this.preview;
        if (!preview || input.previewId !== preview.previewId || input.digest !== preview.digest) throw conflict();
        // A wizard remains open after ACK: its journal must never inherit or replay the opening job.
        return jobContext.exit(() =>
            withProjectFiles(this.context.descriptor.projectId, async (root) => {
                if (root !== this.context.root) throw conflict();
                await this.admit();
                await preview.plan.verifySnapshot();
                const currentProtection = await managedProtection(this.context, preview.plan);
                assertManualFile(preview.file.path, currentProtection);
                if (preview.file.kind === 'opencode')
                    await preserveConnections(
                        preview.plan,
                        preview.file.path,
                        preview.before,
                        preview.after,
                        currentProtection,
                    );
                if (preview.file.kind === 'rag') {
                    await provenRag(this.context, preview.plan);
                    preserveRagProfile(
                        configurationObject(preview.before, true),
                        configurationObject(preview.after, true),
                        await hasManagedRagProfile(this.context),
                    );
                }
                await preview.plan.write(preview.file.path, preview.after);
                const verify = async () => {
                    await this.admit();
                    if (preview.file.kind === 'rag')
                        preserveRagProfile(
                            configurationObject(preview.before, true),
                            configurationObject(preview.after, true),
                            await hasManagedRagProfile(this.context),
                        );
                    await preview.plan.verifySnapshot();
                };
                const recoveryPath = await commitChanges(
                    root,
                    preview.plan.changes(),
                    {
                        action: 'install',
                        assetKey: hash('project-configuration:' + this.context.descriptor.projectId).slice(0, 24),
                        manifest: preview.digest,
                    },
                    { verifySnapshot: verify },
                );
                this.preview = undefined;
                this.opened = undefined;
                return {
                    saved: true,
                    recoveryPath,
                    note: 'Файл сохранён. OpenCode перечитает настройку при следующем запуске; индексация не запускалась.',
                };
            }),
        );
    }
}
