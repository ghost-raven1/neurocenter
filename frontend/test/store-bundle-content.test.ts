import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { IAiPlugin } from '../src/core/api/interfaces';
import { StoreBundleContent } from '../src/modules/Store/StoreBundleContent';

const artifact = { target: 'darwin-arm64', sha256: 'a'.repeat(64), compressedBytes: 100, unpackedBytes: 200, filesCount: 2, entrypoint: 'runtime/index.mjs' };
const plugin: IAiPlugin = {
    id: 'prepared', name: 'OpenCodeRAG', kind: 'mcp', description: '', version: 1, compatibility: null,
    tags: [], origin: '', revision: null, createdAt: '', updatedAt: '', files: [],
    config: { extra: { runtimeArtifacts: [artifact], localConfiguration: { schemaVersion: 1, fields: [] } } },
};
const render = (value: IAiPlugin): string => renderToStaticMarkup(createElement(StoreBundleContent, { plugin: value, copying: false, onCopy: vi.fn() }));

describe('Содержимое устанавливаемого инструмента', () => {
    it('Показывает доставку через мост, фактические платформы и локальный мастер без раскрытого JSON', () => {
        const html = render(plugin);
        expect(html).toContain('Готовый комплект через мост');
        expect(html).toContain('macOS · Apple Silicon');
        expect(html).not.toContain('Windows');
        expect(html).toContain('Мост скачает совместимый комплект');
        expect(html).toContain('локальный мастер настройки');
        expect(html).toContain('после установки');
        expect(html).toContain('Платформенные файлы и контрольные суммы');
        expect(html).toContain('Дополнительно: конфигурация подключения');
        expect(html).not.toContain('aria-label="Конфигурация JSON"');
        expect(html).not.toContain(artifact.sha256);
        expect(html).not.toContain('runtimeArtifacts');
    });

    it('Обычный плагин сохраняет видимый список файлов без объявления готовых зависимостей', () => {
        const html = render({ ...plugin, kind: 'plugin', config: { entrypoint: 'plugin.mjs' }, files: [{ path: 'plugin.mjs', size: 1, digest: 'digest', content: 'export default {};' }] });
        expect(html).toContain('Файлы пакета · 1');
        expect(html).toContain('plugin.mjs');
        expect(html).not.toContain('Готовый комплект через мост');
        expect(html).not.toContain('локальный мастер настройки');
    });

    it('Повреждённая декларация не обещает совместимую доставку', () => {
        const html = render({ ...plugin, config: { extra: { runtimeArtifacts: [{ target: 'darwin-arm64' }] } } });
        expect(html).toContain('Некорректное описание готовых зависимостей');
        expect(html).not.toContain('Мост скачает совместимый комплект');
        expect(html).not.toContain('Поддерживаемые платформы');
    });

    it('При отсутствии файлов и конфигурации показывает объяснение', () => {
        expect(render({ ...plugin, config: null })).toContain('Файлы и конфигурация не опубликованы');
    });
});
