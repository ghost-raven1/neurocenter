import { describe, expect, it } from 'vitest';
import { defaultPackagingTitle, packagingTitle } from '../src/modules/Store/packaging/packagingTitle';

describe('Название собираемого инструмента', () => {
    it('Для scoped npm генерирует допустимое узнаваемое название', () => {
        expect(defaultPackagingTitle('@modelcontextprotocol/server-filesystem')).toBe('modelcontextprotocol · server-filesystem');
        expect(packagingTitle('', '@modelcontextprotocol/server-filesystem')).not.toContain('/');
    });
    it('Сохраняет plain npm название и разрешённое пользовательское имя', () => {
        expect(packagingTitle('', 'opencode-snip')).toBe('opencode-snip');
        expect(packagingTitle('  Поиск по проекту  ', '@scope/name')).toBe('Поиск по проекту');
    });
    it.each(['scope/name', 'scope\\name', 'ai-plug-reserved', '__proto__', 'bad\nname', 'x'.repeat(129)])('Отклоняет пользовательское название до отправки сборки: %s', name => {
        expect(() => packagingTitle(name, '@scope/name')).toThrow('Название');
    });
});
