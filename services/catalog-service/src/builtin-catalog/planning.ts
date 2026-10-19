import { isDeepStrictEqual } from 'node:util';
import type { IAiPlugin, IAiPluginConfig, IAiPluginUpdate } from '../catalog/dto';
import { publicationHash } from '../publication/publication-validation';
import type { IBuiltinTool } from './manifest';

export interface IBuiltinReceipt { tool_key: string; asset_id: string; release: string; publication_hash: string; card_hash: string }
export interface IBuiltinPlan { tool: IBuiltinTool; current: IAiPlugin | null; receipt?: IBuiltinReceipt; action: 'create' | 'update' | 'unchanged'; patch?: IAiPluginUpdate }

/** Отпечаток исключает время чтения, но фиксирует все редактируемые данные и номер версии. */
export function builtinCardHash(card: IAiPlugin): string {
    const { createdAt: _created, updatedAt: _updated, ...content } = card;
    return publicationHash(content);
}

function settings(config: IAiPluginConfig | null): Record<string, unknown> {
    const { command: _command, entrypoint: _entrypoint, transport: _transport, ...rest } = config ?? {};
    const { runtimeArtifacts: _artifacts, ...extra } = rest.extra ?? {};
    const result: Record<string, unknown> = { ...rest, ...(Object.keys(extra).length ? { extra } : {}) };
    if (!Object.keys(extra).length) { delete result.extra; }
    for (const key of ['args', 'env']) {
        const value = result[key];
        if (value && typeof value === 'object' && !Object.keys(value).length) { delete result[key]; }
    }
    return result;
}

/** Старую npm-команду узнаём по одному известному пакету, который здесь не исполняется. */
function legacyNpx(tool: IBuiltinTool, config: IAiPluginConfig): boolean {
    if (config.command !== 'npx' || !Array.isArray(config.args)) { return false; }
    const args = [...config.args];
    if (args[0] === '-y' || args[0] === '--yes') { args.shift(); }
    if (args.length !== 1) { return false; }
    const match = /^((?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)(?:@(\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?(?:\+[a-z0-9.-]+)?))?$/i.exec(args[0]);
    return !!match && !!tool.legacyPackages?.includes(match[1]);
}

function compatibleConfig(tool: IBuiltinTool, card: IAiPlugin): boolean {
    const config = card.config;
    if (isDeepStrictEqual(config, tool.publication.config) && isDeepStrictEqual(card.files, tool.publication.files ?? [])) { return true; }
    // Неизвестный готовый комплект может быть собственной сборкой под тем же именем и источником.
    if (!config || config.transport === 'remote' || card.files.length || config.entrypoint
        || config.extra?.runtimeArtifacts !== undefined || !legacyNpx(tool, config)) { return false; }
    const old = settings(config), next = settings(tool.publication.config ?? null);
    delete old.args;
    // Отсутствующие настройки можно добавить; собственные значения и схемы не перезаписываем.
    return Object.entries(old).every(([key, value]) => isDeepStrictEqual(value, next[key]));
}

/** Все конфликты планируются до скачивания и до первой новой версии карточки. */
export function planBuiltinTool(tool: IBuiltinTool, card: IAiPlugin | null, receipt?: IBuiltinReceipt): IBuiltinPlan {
    const conflict = (): never => { throw new Error(`«${tool.publication.name}»: карточка изменена пользователем или её источник не подтверждён. Сохраните настройки и исправьте конфликт поставки вручную.`); };
    if (receipt) {
        if (!card || card.id !== receipt.asset_id || builtinCardHash(card) !== receipt.card_hash) { conflict(); }
        if (publicationHash(tool.publication) === receipt.publication_hash) { return { tool, current: card, receipt, action: 'unchanged' }; }
    } else if (card && (card.kind !== tool.publication.kind || !tool.legacyOrigins.includes(card.origin) || !compatibleConfig(tool, card))) { conflict(); }
    if (!card) { return { tool, current: null, action: 'create' }; }
    // Описания, теги, источник и закреплённые зависимости принадлежат существующей карточке.
    const patch: IAiPluginUpdate = { expectedVersion: card.version, config: tool.publication.config, files: tool.publication.files ?? [],
        revision: tool.publication.revision, compatibility: tool.publication.compatibility ?? null };
    const changed = Object.entries(patch).some(([key, value]) => key !== 'expectedVersion' && !isDeepStrictEqual(value, card[key as keyof IAiPlugin]));
    return { tool, current: card, receipt, action: changed ? 'update' : 'unchanged', patch };
}
