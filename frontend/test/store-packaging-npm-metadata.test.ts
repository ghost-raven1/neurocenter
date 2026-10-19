import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NpmMetadataDetails } from '../src/modules/Store/packaging/NpmMetadataDetails';
import type { NpmPackageMetadata } from '../src/modules/Store/packaging/types';

const metadata: NpmPackageMetadata = {
    package: 'opencode-rag-plugin', version: '2.4.4', specifier: 'opencode-rag-plugin@2.4.4',
    entrypoint: 'dist/index.js', candidates: ['dist/index.js'], description: '', recommendedKind: 'mcp',
};
const render = (value: NpmPackageMetadata) => renderToStaticMarkup(createElement(NpmMetadataDetails, { metadata: value }));

describe('Совместимость npm-пакета перед упаковкой', () => {
    it('Показывает закреплённую версию и файл запуска обычного npm-пакета', () => {
        const html = render(metadata);
        expect(html).toContain('opencode-rag-plugin@2.4.4');
        expect(html).toContain('Файл запуска: dist/index.js');
        expect(html).not.toContain('Готовый совместимый адаптер');
        expect(html).not.toContain('Поддерживаемые платформы');
    });
    it('Показывает только платформы готового адаптера и явно сообщает об отсутствии Intel Mac', () => {
        const html = render({ ...metadata, supportedTargets: ['darwin-arm64', 'linux-x64-glibc', 'win32-arm64'] });
        expect(html).toContain('Готовый совместимый адаптер');
        expect(html).toContain('macOS · Apple Silicon');
        expect(html).toContain('Linux · x64 · glibc');
        expect(html).toContain('Windows · ARM64');
        expect(html).toContain('Mac с Intel не поддерживается этим комплектом.');
        expect(html).not.toContain('macOS · Intel');
        expect(html).not.toContain('Файл запуска');
    });
    it('Не сообщает об ограничении Intel, если готовый комплект для Intel есть', () => {
        const html = render({ ...metadata, supportedTargets: ['darwin-arm64', 'darwin-x64'] });
        expect(html).toContain('macOS · Intel');
        expect(html).not.toContain('не поддерживается');
    });
    it('Не делает выводов о macOS для адаптера с другими платформами', () => {
        const html = render({ ...metadata, supportedTargets: ['linux-arm64-musl'] });
        expect(html).toContain('Linux · ARM64 · musl');
        expect(html).not.toContain('Mac');
    });
    it('Пустой список целей не подменяет обещанием всех платформ', () => {
        const html = render({ ...metadata, supportedTargets: [] });
        expect(html).toContain('Файл запуска: dist/index.js');
        expect(html).not.toContain('Поддерживаемые платформы');
    });
});
