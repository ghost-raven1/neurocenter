import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser';
import { pathToFileURL } from 'node:url';
import { runtimeArtifactConnection } from '../features/runtime-artifacts/connection.js';
import { projectFolder, projectBindingId, safeTarget } from './workspace.js';
import { hash } from './state.js';
import { verify, type Package } from './package.js';
import { InstallationPlan } from './installation-plan.js';
import { InstallationLedger } from './installation-ledger.js';
import { assetBase, assetKey, receiptPath, removalReceipt, sameValue } from './installation-receipt.js';
import { commitChanges, removalCompleted, withProjectFiles, type FileChange } from './installation-files.js';

/** Удаляет только неизменённые файлы пакета; личный журнал сохраняет данные для восстановления. */
export async function uninstall(
    projectId: string,
    pkg: Package,
    authorize: () => Promise<unknown>,
    progress: (percent: number, message: string) => Promise<unknown>,
) {
    verify(pkg);
    return withProjectFiles(projectId, async (root) => {
        const key = assetKey(pkg);
        const relativeReceipt = receiptPath(pkg);
        const plan = new InstallationPlan(root);
        const raw = await plan.read(relativeReceipt);
        if (raw === null) {
            const previous = await removalCompleted(root, key, pkg.manifest.sha256);
            if (!previous) {
                throw new Error(
                    'Квитанция отсутствует. Файлы без подтверждённой установки автоматически не удаляются.',
                );
            }
            await authorize();
            return {
                projectId,
                assetId: pkg.plugin.id,
                version: pkg.plugin.version,
                manifest: pkg.manifest.sha256,
                bindingId: await projectBindingId(projectId),
                changed: false,
                ...previous,
            };
        }
        const receipt = removalReceipt(raw, pkg);
        const ledger = await InstallationLedger.load(plan);
        ledger.assertRemoval(pkg);
        const changes: FileChange[] = [];
        for (const [relative, digest] of Object.entries(receipt.files)) {
            const current = await plan.read(relative, 'base64');
            if (current === null) {
                continue;
            }
            if (hash(Buffer.from(current, 'base64')) !== digest) {
                throw new Error(
                    'Файл изменён вручную: ' + relative + '. Удаление остановлено, ваши изменения сохранены.',
                );
            }
            changes.push({ relative, before: current, after: null, encoding: 'base64' });
        }
        if (receipt.config) {
            const before = await plan.read(receipt.config.path);
            if (before !== null) {
                const errors: ParseError[] = [];
                const parsed = parse(before, errors, {
                    allowTrailingComma: true,
                }) as Record<string, unknown> | null;
                if (errors.length || !parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
                    throw new Error('Исправьте JSON/JSONC OpenCode перед удалением. Файлы и конфигурация не изменены.');
                }
                let editPath: (string | number)[];
                let value: unknown;
                let edit: boolean;
                if (pkg.plugin.kind === 'mcp') {
                    if (
                        parsed.mcp !== undefined &&
                        (!parsed.mcp || Array.isArray(parsed.mcp) || typeof parsed.mcp !== 'object')
                    ) {
                        throw new Error('Поле mcp изменено вручную. Удаление остановлено.');
                    }
                    const current = (parsed.mcp as Record<string, unknown> | undefined)?.[receipt.config.key];
                    if (current !== undefined && !sameValue(current, receipt.config.value)) {
                        throw new Error('Подключение MCP изменено вручную. Удаление остановлено.');
                    }
                    editPath = ['mcp', receipt.config.key];
                    value = undefined;
                    edit = current !== undefined;
                } else {
                    const runtime = runtimeArtifactConnection(pkg);
                    const expected = pathToFileURL(
                        runtime?.entrypoint ?? (await safeTarget(root, `${assetBase(pkg)}/${pkg.config?.entrypoint}`)),
                    ).href;
                    if (receipt.config.value !== expected) {
                        throw new Error('Путь плагина в квитанции изменён. Удаление остановлено.');
                    }
                    const plugins = parsed.plugin ?? [];
                    if (!Array.isArray(plugins)) {
                        throw new Error('Поле plugin изменено вручную. Удаление остановлено.');
                    }
                    const packageUrl =
                        pathToFileURL(runtime?.root ?? (await safeTarget(root, assetBase(pkg)))).href + '/';
                    // Один готовый архив может содержать несколько независимо подключённых плагинов.
                    if (
                        (!runtime || !plugins.includes(expected)) &&
                        plugins.some(
                            (item) => typeof item === 'string' && item.startsWith(packageUrl) && item !== expected,
                        )
                    ) {
                        throw new Error('Путь плагина изменён вручную. Удаление остановлено.');
                    }
                    value = plugins.filter((item) => !sameValue(item, expected));
                    editPath = ['plugin'];
                    edit = plugins.length !== (value as unknown[]).length;
                }
                if (edit) {
                    const after = applyEdits(
                        before,
                        modify(before, editPath, value, {
                            formattingOptions: {
                                insertSpaces: true,
                                tabSize: 2,
                                eol: '\n',
                            },
                        }),
                    );
                    changes.push({
                        relative: receipt.config.path,
                        before,
                        after,
                    });
                }
            }
        }
        changes.push({ relative: relativeReceipt, before: raw, after: null });
        for (const change of changes) {
            await plan.write(change.relative, change.after, change.encoding);
        }
        await ledger.remove(pkg);
        await progress(35, 'Квитанция, файлы и подключение проверены');
        await authorize();
        if ((await projectFolder(projectId)) !== root) {
            throw new Error('Привязка папки изменилась во время удаления. Повторите запрос.');
        }
        await plan.verifySnapshot();
        const result = {
            projectId,
            assetId: pkg.plugin.id,
            version: pkg.plugin.version,
            bindingId: await projectBindingId(projectId),
            manifest: pkg.manifest.sha256,
            changed: true,
            files: changes.filter((change) => change.after === null && change.relative !== relativeReceipt).length,
            note: 'Управляемые файлы и подключение удалены. Резервная копия осталась в личной папке MCP. Изменения OpenCode применит при следующем запуске.',
        };
        const recoveryPath = await commitChanges(root, plan.changes(), {
            action: 'uninstall',
            assetKey: key,
            manifest: pkg.manifest.sha256,
            result,
        });
        return { ...result, recoveryPath };
    });
}
