import { describe, expect, it } from 'vitest';
import { CatalogService } from '../src/catalog/catalog.service';
import { verifyPackage } from '../src/catalog/bundle-package';
import type { IAiPlugin, IAiPluginVersion } from '../src/catalog/dto';

const pin = { kind: 'mcp' as const, id: 'ai-plug-dependency', version: 1, manifest: 'a'.repeat(64) };
const plugin: IAiPlugin = { id: 'ai-plug-helper', name: 'Помощник', kind: 'mcp', description: 'Описание',
    version: 2, compatibility: null, tags: [], origin: 'upload', revision: null,
    config: { transport: 'remote', url: 'https://example.org/mcp' }, files: [], createdAt: 'now', updatedAt: 'now', dependencies: [pin] };
const history: IAiPluginVersion = { version: 1, files: [], config: plugin.config, author: 'admin', note: '', createdAt: 'then' };
const service = (current: IAiPlugin, saved: IAiPluginVersion) => ({
    getAiPlugin: async () => current,
    db: { getAiPluginVersion: async () => saved },
}) as unknown as CatalogService;

describe('Зависимости неизменяемого MCP/плагина', () => {
    it('Добавляет pins текущей карточки в защищённую конфигурацию пакета', async () => {
        const pkg = await CatalogService.prototype.getAiPluginPackage.call(service(plugin, history), plugin.id);
        expect(pkg.config?.extra?.requirements).toEqual({ mcp: [], plugins: [], dependencies: [pin] });
        expect(verifyPackage(pkg)).toBe(true);
    });
    it('Старая версия без pins не наследует зависимости текущей карточки', async () => {
        const pkg = await CatalogService.prototype.getAiPluginPackage.call(service(plugin, history), plugin.id, 1);
        expect(pkg.plugin.version).toBe(1); expect(pkg.config?.extra).toBeUndefined();
    });
    it('Точный номер выбирает собственные pins исторической версии', async () => {
        const previous = { ...pin, version: 3, manifest: 'b'.repeat(64) };
        const pkg = await CatalogService.prototype.getAiPluginPackage.call(service(plugin, { ...history, metadata: { kind: 'mcp', description: '', compatibility: null, tags: [], origin: 'upload', revision: null, dependencies: [previous] } }), plugin.id, 1);
        expect(pkg.config?.extra?.requirements).toEqual({ mcp: [], plugins: [], dependencies: [previous] });
    });
    it('Пустые зависимости не меняют конфигурацию прежних пакетов', async () => {
        const pkg = await CatalogService.prototype.getAiPluginPackage.call(service({ ...plugin, dependencies: [] }, history), plugin.id);
        expect(pkg.config).toEqual(plugin.config);
    });
});
