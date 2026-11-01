import { canonicalV4, type IPackage } from '../../src/bridge/package.js';
import { hash } from '../../src/bridge/state.js';
import { packageRef, installSetManifest, type IInstallSet } from '../../src/bridge/install-set.js';

/** Закреплённые тестовые пакеты не используют глобальный профиль или внешние команды. */
export function setPackage(id: string, kind = 'mcp', version = 1, dependencies: IPackage[] = [], files = 1): IPackage {
    const plugin = { kind, id, version, name: id.replace(/[^a-z0-9-]/g, '-') };
    const config =
        kind === 'skill' && !dependencies.length
            ? null
            : {
                  ...(kind === 'skill' ? {} : { command: 'node', entrypoint: 'index.mjs' }),
                  ...(dependencies.length
                      ? { extra: { requirements: { dependencies: dependencies.map(packageRef) } } }
                      : {}),
              };
    const entries = Array.from({ length: files }, (_, i) => ({
        path: i ? `assets/file-${i}.txt` : kind === 'skill' ? 'SKILL.md' : 'index.mjs',
        content: `${id} версия ${version} файл ${i}`,
    })).map((file) => ({ ...file, size: Buffer.byteLength(file.content), sha256: hash(file.content) }));
    return rehashPackage({
        schemaVersion: 4,
        plugin,
        config,
        files: entries,
        manifest: { sha256: '', filesCount: entries.length },
    });
}
export function rehashPackage(pkg: IPackage): IPackage {
    pkg.manifest = {
        filesCount: pkg.files.length,
        sha256: hash(
            JSON.stringify(
                canonicalV4({
                    schemaVersion: pkg.schemaVersion,
                    plugin: pkg.plugin,
                    config: pkg.config,
                    files: pkg.files
                        .map(({ path, size, sha256, encoding }) => ({
                            path,
                            size,
                            sha256,
                            ...(encoding ? { encoding } : {}),
                        }))
                        .sort((a, b) => (a.path === b.path ? 0 : a.path < b.path ? -1 : 1)),
                }),
            ),
        ),
    };
    return pkg;
}
export function setFixture(root: IPackage, dependencies: IPackage[]): IInstallSet {
    const packages = [root, ...dependencies];
    const reference = packageRef(root);
    return { schemaVersion: 1, root: reference, packages, manifest: installSetManifest(reference, packages) };
}
