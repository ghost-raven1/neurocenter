import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { artifactFixture } from '../../../scripts/test/runtime-artifact-fixture.cjs';
import { CatalogService } from '../src/catalog/catalog.service';
import { buildPackage } from '../src/catalog/bundle-package';
import type { IAiPlugin, IAiPluginConfig, IAiPluginVersion } from '../src/catalog/dto';
import { DeviceArtifacts } from '../src/devices/device-artifacts';
import {
    assertInstallablePackage, installationRef, resolveInstallationSet, verifyInstallationSet,
} from '../src/devices/installation-set';

const projectId = 'prj-runtime-history';
const { descriptor } = artifactFixture();
const bundled: IAiPluginConfig = { transport: 'stdio', extra: { runtimeArtifacts: [descriptor] } };
const current = (id: string, config: IAiPluginConfig): IAiPlugin => ({
    id, name: id, kind: 'mcp', description: '', version: 2, config, files: [],
    compatibility: null, tags: [], origin: 'upload', revision: null, createdAt: 'now', updatedAt: 'now',
});
const saved = (config: IAiPluginConfig, dependencies?: IAiPlugin['dependencies']): IAiPluginVersion => ({
    version: 1, config, files: [], author: 'admin', note: '', createdAt: 'then',
    metadata: { kind: 'mcp', description: '', compatibility: null, tags: [], origin: 'upload', revision: null,
        ...(dependencies?.length ? { dependencies } : {}) },
});
const catalogFor = (cards: IAiPlugin[], versions: Map<string, IAiPluginVersion>) => {
    const getAiPluginVersion = vi.fn(async (id: string, version: number) => versions.get(`${id}:${version}`));
    const catalog = {
        getAiPlugin: async (id: string) => cards.find(card => card.id === id),
        getAiPluginPackage: CatalogService.prototype.getAiPluginPackage,
        db: { getAiPluginVersion },
    } as unknown as CatalogService;
    return { artifacts: new DeviceArtifacts(catalog), getAiPluginVersion };
};
const allowedPool = (ids: string[]) => ({ query: vi.fn(async (_sql: string, parameters: unknown[]) => ({
    rows: [], rowCount: parameters[0] === projectId && parameters[1] === 'mcp' && ids.includes(String(parameters[2])) ? 1 : 0,
})) }) as unknown as Pool;

describe('Готовые комплекты точных исторических версий MCP', () => {
    it('Сохраняет артефакты корня и закреплённой зависимости, когда текущие карточки уже другие', async () => {
        const rootId = 'ai-plug-history-root', dependencyId = 'ai-plug-history-dependency';
        const dependency = buildPackage({ id: dependencyId, name: dependencyId, kind: 'mcp', version: 1 }, [], 'then', bundled);
        const cards = [rootId, dependencyId].map(id => current(id, { transport: 'remote', url: 'https://example.test/changed' }));
        const { artifacts, getAiPluginVersion } = catalogFor(cards, new Map([
            [`${rootId}:1`, saved(bundled, [installationRef(dependency)])], [`${dependencyId}:1`, saved(bundled)],
        ]));
        const root = await artifacts.build('mcp', rootId, 1);
        expect(root.schemaVersion).toBe(5);
        expect(root.config?.extra?.runtimeArtifacts).toEqual([descriptor]);
        expect(root.config?.extra?.requirements).toEqual({ mcp: [], plugins: [], dependencies: [installationRef(dependency)] });
        expect(() => assertInstallablePackage(root)).not.toThrow();
        const set = await resolveInstallationSet(allowedPool([rootId, dependencyId]), projectId, root,
            (kind, id, version) => artifacts.build(kind, id, version));
        expect(verifyInstallationSet(set!)).toBe(true);
        expect(set?.packages.map(pkg => ({ version: pkg.plugin.version, artifacts: pkg.config?.extra?.runtimeArtifacts })))
            .toEqual([{ version: 1, artifacts: [descriptor] }, { version: 1, artifacts: [descriptor] }]);
        expect(getAiPluginVersion.mock.calls).toEqual([[rootId, 1], [dependencyId, 1]]);
    });

    it.each(['npx', 'uvx'])('Не подменяет незакреплённую старую команду %s готовым комплектом текущей карточки', async command => {
        const id = 'ai-plug-unbundled-history';
        const { artifacts } = catalogFor([current(id, bundled)], new Map([
            [`${id}:1`, saved({ transport: 'stdio', command, args: ['fixture@1.0.0'] })],
        ]));
        const pkg = await artifacts.build('mcp', id, 1);
        expect(pkg.plugin.version).toBe(1);
        expect(pkg.config?.extra?.runtimeArtifacts).toBeUndefined();
        expect(() => assertInstallablePackage(pkg)).toThrow('Внешняя команда MCP не входит в закреплённый пакет');
        await expect(resolveInstallationSet(allowedPool([id]), projectId, pkg, vi.fn())).rejects.toMatchObject({
            response: { code: 'PACKAGE_NOT_INSTALLABLE', dependency: false, package: { id, version: 1 } },
        });
    });
});
