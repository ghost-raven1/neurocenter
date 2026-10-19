import { afterEach, describe, expect, it, vi } from 'vitest';
import * as packageModule from '../src/bridge/package.js';
import { hash } from '../src/bridge/state.js';
import { installSetManifest, packageRef, verifyInstallSet } from '../src/bridge/install-set.js';
import { rehashPackage, setFixture, setPackage } from './install-set-fixture.js';

describe('Закреплённый граф установки MCP', () => {
    afterEach(() => vi.restoreAllMocks());
    it('Принимает точное транзитивное замыкание с общей зависимостью', () => {
        const shared = setPackage('shared');
        const a = setPackage('a', 'mcp', 1, [shared]);
        const b = setPackage('b', 'plugin', 1, [shared]);
        const root = setPackage('root', 'skill', 1, [a, b]);
        expect(verifyInstallSet(setFixture(root, [a, b, shared]))).toHaveLength(4);
    });
    it('Хэш не зависит от порядка доставки пакетов', () => {
        const dep = setPackage('dep');
        const root = setPackage('root', 'skill', 1, [dep]);
        expect(installSetManifest(packageRef(root), [root, dep])).toBe(installSetManifest(packageRef(root), [dep, root]));
    });
    it('Отклоняет незакреплённую старую зависимость', () => {
        const dep = setPackage('dep');
        const root = setPackage('root', 'skill', 1, [dep]);
        root.config!.extra!.requirements!.mcp = ['dep'];
        rehashPackage(root);
        expect(() => verifyInstallSet(setFixture(root, [dep]))).toThrow('без закреплённых');
    });
    it('Отклоняет недостающий транзитивный пакет', () => {
        const dep = setPackage('dep');
        const root = setPackage('root', 'skill', 1, [dep]);
        expect(() => verifyInstallSet(setFixture(root, [setPackage('other')]))).toThrow('отсутствует');
    });
    it('Отклоняет лишний исполняемый пакет вне графа', () => {
        const dep = setPackage('dep');
        const root = setPackage('root', 'skill', 1, [dep]);
        expect(() => verifyInstallSet(setFixture(root, [dep, setPackage('extra')]))).toThrow('лишние');
    });
    it('Отклоняет несовпадение закреплённой версии', () => {
        const dep = setPackage('dep');
        const root = setPackage('root', 'skill', 1, [dep]);
        expect(() => verifyInstallSet(setFixture(root, [setPackage('dep', 'mcp', 2)]))).toThrow('точная версия');
    });
    it('Отклоняет повтор и конфликт одного ID в наборе', () => {
        const dep = setPackage('dep');
        const root = setPackage('root', 'skill', 1, [dep]);
        expect(() => verifyInstallSet(setFixture(root, [dep, dep]))).toThrow('Повтор');
        expect(() => verifyInstallSet(setFixture(root, [dep, setPackage('dep', 'mcp', 2)]))).toThrow('конфликт');
    });
    it('Отклоняет повтор закрепления внутри одного пакета', () => {
        const dep = setPackage('dep');
        const root = setPackage('root', 'skill', 1, [dep, dep]);
        expect(() => verifyInstallSet(setFixture(root, [dep]))).toThrow('Повтор зависимости');
    });
    it('Отклоняет подмену хэша набора', () => {
        const dep = setPackage('dep');
        const root = setPackage('root', 'skill', 1, [dep]);
        expect(() => verifyInstallSet({ ...setFixture(root, [dep]), manifest: '0'.repeat(64) })).toThrow('Хэш набора');
    });
    it('Отклоняет нулевую версию и зависимость неподдерживаемого типа', () => {
        const dep = setPackage('dep');
        const root = setPackage('root', 'skill', 1, [dep]);
        root.config!.extra!.requirements!.dependencies![0]!.kind = 'skill';
        rehashPackage(root);
        expect(() => verifyInstallSet(setFixture(root, [dep]))).toThrow('закреплённые');
        expect(() => verifyInstallSet({ ...setFixture(root, [dep]), root: { ...packageRef(root), version: 0 } })).toThrow('Некорректный набор');
    });
    it('Отклоняет более 20 пакетов и более 200 файлов суммарно', () => {
        const dependencies = Array.from({ length: 20 }, (_, i) => setPackage('dep-' + i));
        const root = setPackage('root', 'skill', 1, dependencies);
        expect(() => verifyInstallSet(setFixture(root, dependencies))).toThrow('Некорректный набор');
        const a = setPackage('a', 'mcp', 1, [], 100);
        const b = setPackage('b', 'mcp', 1, [], 100);
        expect(() => verifyInstallSet(setFixture(setPackage('root', 'skill', 1, [a, b]), [a, b]))).toThrow('200 файлов');
    });
    it('Отклоняет цикл графа независимо от корректности хэшей отдельных пакетов', () => {
        const a = setPackage('a'); const b = setPackage('b');
        a.config!.extra = { requirements: { dependencies: [packageRef(b)] } };
        b.config!.extra = { requirements: { dependencies: [packageRef(a)] } };
        vi.spyOn(packageModule, 'verify').mockImplementation(() => undefined);
        expect(() => verifyInstallSet(setFixture(a, [b]))).toThrow('Цикл');
    });
    it('Отклоняет суммарно более 16 МБ декодированных файлов', () => {
        const content = 'x'.repeat(1048576);
        const dependencies = Array.from({ length: 4 }, (_, i) => {
            const pkg = setPackage('dep-' + i, 'mcp', 1, [], 4);
            pkg.files = pkg.files.map(file => ({ ...file, content, size: content.length, sha256: hash(content) }));
            return rehashPackage(pkg);
        });
        const root = setPackage('root', 'skill', 1, dependencies);
        root.files[0]!.content = content; root.files[0]!.size = content.length; root.files[0]!.sha256 = hash(content);
        rehashPackage(root);
        expect(() => verifyInstallSet(setFixture(root, dependencies))).toThrow('16 МБ');
    });
});
