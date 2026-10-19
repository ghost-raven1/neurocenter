import bffApi from '../../core/api/bff';

import type { IStoreApp } from './AppCard';

export interface IInstallResult {
    ok: boolean;
    message: string;
}

/**
 * Стандартизированная установка/удаление «приложения» в проект — единый
 * one-click-путь для ВСЕХ типов (скилл/MCP/плагин):
 *   - skill  → content (из каталога, getSkill),
 *   - plugin → files (дерево из каталога) или origin,
 *   - mcp    → config (из каталога).
 * Все записи идут через единственный endpoint `local-assets/install`.
 *
 * @param {IStoreApp} app - приложение витрины.
 * @param {string} projectName - целевой проект.
 * @param {'install' | 'uninstall'} action - действие.
 * @returns {Promise<IInstallResult>} сводка.
 */
export async function installApp(
    app: IStoreApp,
    projectName: string,
    action: 'install' | 'uninstall' = 'install',
): Promise<IInstallResult> {
    const baseBody = {
        kind: app.kind,
        name: app.name,
        projectName,
        origin: app.origin || undefined,
        action,
    };

    let body: typeof baseBody & { content?: string; config?: Record<string, unknown>; files?: { path: string; content: string }[] };
    body = baseBody;

    if (action === 'install') {
        if (app.kind === 'skill') {
            const file = await bffApi.getSkill(app.path ?? app.id);
            const frontmatter = Object.entries(file.meta)
                .filter(([, value]) => value !== undefined)
                .map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n');
            body = { ...body, content: `---\n${frontmatter}\n---\n\n${file.body || ''}`, origin: app.path ?? undefined };
        } else {
            const files = (app.files ?? []).map(f => ({ path: f.path, content: f.content ?? '' })).filter(f => f.content.length > 0);
            if (files.length > 0) {
                body = { ...body, files };
            }
            if (app.kind === 'mcp' && app.config) { body = { ...body, config: app.config }; }
        }
    }

    try {
        await bffApi.installLocalAsset(body);
        return {
            ok: true,
            message: action === 'install'
                ? `«${app.name}» установлен в «${projectName}»`
                : `«${app.name}» удалён из «${projectName}»`,
        };
    } catch (err) {
        const e = err as { response?: { data?: { message?: string } } };
        return { ok: false, message: e?.response?.data?.message ?? 'Не удалось выполнить установку' };
    }
}
