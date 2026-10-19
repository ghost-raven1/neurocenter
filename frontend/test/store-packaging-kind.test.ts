import { describe, expect, it } from 'vitest';
import { packagingKind } from '../src/modules/Store/packaging/packagingKind';
import type { NpmPackageMetadata } from '../src/modules/Store/packaging/types';

const metadata: NpmPackageMetadata = { package: 'opencode-snip', version: '2.0.0', specifier: 'opencode-snip@2.0.0', entrypoint: 'plugin.mjs', candidates: [], description: '', recommendedKind: 'plugin' };
describe('Тип упаковываемого npm инструмента', () => {
    it('opencode-snip выбирается плагином перед отправкой первого запроса', () => {
        expect(packagingKind('mcp', metadata, false)).toBe('plugin');
    });
    it('Явный выбор пользователя не меняется автоматически', () => {
        expect(packagingKind('mcp', metadata, true)).toBe('mcp');
    });
    it('Отсутствие рекомендации сохраняет выбранный тип', () => {
        expect(packagingKind('plugin', { ...metadata, recommendedKind: undefined }, false)).toBe('plugin');
        expect(packagingKind('mcp', undefined, false)).toBe('mcp');
    });
});
