import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { buildPackage } from '../src/catalog/bundle-package';
import { assertPublicationDependencies } from '../src/publication/publication-dependencies';
import type { IDependencyPin } from '../../shared/dependency-pins.cjs';

const config = { transport: 'remote' as const, url: 'https://example.test/mcp' };
const file = (path: string, content = 'x') => ({ path, content });

function graph() {
    const versions = new Map<string, Record<string, unknown>>();
    const query = vi.fn(async (_sql: string, params: unknown[]) => ({ rows: versions.has(`${params[0]}:${params[1]}`) ? [versions.get(`${params[0]}:${params[1]}`)] : [] }));
    const add = (id: string, dependencies: IDependencyPin[] = [], version = 1, files: Array<{ path: string; content: string }> = []) => {
        const name = id;
        const metadata = { kind: 'mcp', dependencies };
        versions.set(`${id}:${version}`, { id, name, kind: 'mcp', files, config, metadata });
        const packedConfig = dependencies.length ? { ...config, extra: { requirements: { mcp: [], plugins: [], dependencies } } } : config;
        const pkg = buildPackage({ id, name, kind: 'mcp', version }, files, '', packedConfig);
        return { kind: 'mcp' as const, id, version, manifest: pkg.manifest.sha256 };
    };
    return { versions, query, add, client: { query } as unknown as PoolClient };
}

describe('Публикация замкнутого графа зависимостей', () => {
    it('Совместимый ромб использует одну точную leaf версию, а не новый head', async () => {
        const { add, client, query } = graph();
        const leaf = add('ai-plug-leaf'); add(leaf.id, [], 2);
        const left = add('ai-plug-left', [leaf]), right = add('ai-plug-right', [leaf]);
        await expect(assertPublicationDependencies(client, [left, right])).resolves.toBeUndefined();
        expect(query.mock.calls.map(([, params]) => params)).toEqual([[left.id, 1], [leaf.id, 1], [right.id, 1]]);
    });

    it('Отклоняет разные версии одного ID, скрытые за разными непосредственными зависимостями', async () => {
        const { add, client } = graph();
        const one = add('ai-plug-leaf'), two = add(one.id, [], 2);
        await expect(assertPublicationDependencies(client, [add('ai-plug-left', [one]), add('ai-plug-right', [two])])).rejects.toMatchObject({ status: 409 });
    });

    it('Отклоняет разные SHA одной версии даже при повторном достижении уже прочитанной leaf', async () => {
        const { add, client } = graph();
        const leaf = add('ai-plug-leaf');
        await expect(assertPublicationDependencies(client, [add('ai-plug-left', [leaf]), add('ai-plug-right', [{ ...leaf, manifest: 'f'.repeat(64) }])])).rejects.toMatchObject({ status: 409 });
    });

    it('Отклоняет A2→B1→A1 до чтения старой версии самого публикуемого инструмента', async () => {
        const { add, client, query } = graph();
        const oldRoot = add('ai-plug-root'), child = add('ai-plug-child', [oldRoot]);
        await expect(assertPublicationDependencies(client, [child], { id: oldRoot.id })).rejects.toMatchObject({ status: 409 });
        expect(query).toHaveBeenCalledTimes(1);
    });

    it.each(['missing', 'sha'])('Проверяет недоступную вложенную leaf: %s', async reason => {
        const { add, client, versions } = graph();
        const leaf = add('ai-plug-leaf'), child = add('ai-plug-child', [reason === 'sha' ? { ...leaf, manifest: 'f'.repeat(64) } : leaf]);
        if (reason === 'missing') versions.delete(`${leaf.id}:1`);
        await expect(assertPublicationDependencies(client, [child])).rejects.toMatchObject({ status: 409 });
    });

    it('Считает корень в лимите двадцати инструментов и разрешает исправленный повтор', async () => {
        const { add, client } = graph();
        const leaves = Array.from({ length: 19 }, (_, index) => add(`ai-plug-${index}`));
        await expect(assertPublicationDependencies(client, leaves)).resolves.toBeUndefined();
        await expect(assertPublicationDependencies(client, [...leaves, add('ai-plug-overflow')])).rejects.toMatchObject({ status: 409 });
        await expect(assertPublicationDependencies(client, leaves)).resolves.toBeUndefined();
    });

    it('Считает файлы корня и каждую общую зависимость ровно один раз', async () => {
        const { add, client } = graph();
        const files = Array.from({ length: 100 }, (_, index) => file(`${index}.txt`));
        const shared = add('ai-plug-shared', [], 1, files);
        const pins = [add('ai-plug-left', [shared]), add('ai-plug-right', [shared])];
        await expect(assertPublicationDependencies(client, pins, { files })).resolves.toBeUndefined();
        await expect(assertPublicationDependencies(client, [...pins, add('ai-plug-extra', [], 1, [file('extra.txt')])], { files })).rejects.toMatchObject({ status: 409 });
    });

    it('Ограничивает суммарные байты текста вместе с корнем, сохраняя допустимую границу', async () => {
        const { add, client } = graph();
        const files = Array.from({ length: 4 }, (_, index) => file(`${index}.txt`, 'x'.repeat(1024 * 1024)));
        const pins = Array.from({ length: 4 }, (_, index) => add(`ai-plug-large-${index}`, [], 1, files));
        await expect(assertPublicationDependencies(client, pins)).resolves.toBeUndefined();
        await expect(assertPublicationDependencies(client, pins, { files: [file('root.txt')] })).rejects.toMatchObject({ status: 409 });
    });
});
