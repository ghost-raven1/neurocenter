import { ConflictException } from '@nestjs/common';
import type { PoolClient } from 'pg';

import { normalizeDependencyPins, type IDependencyPin } from '../../../shared/dependency-pins.cjs';
import { buildPackage } from '../catalog/bundle-package';
import type { IAiPlugin, IAiPluginVersion } from '../catalog/dto';
import { assertInstallablePackage } from '../devices/installation-set';

interface IDependencyVersion {
    id: string;
    name: string;
    kind: IAiPlugin['kind'];
    files: IAiPluginVersion['files'];
    config: IAiPluginVersion['config'];
    metadata: IAiPluginVersion['metadata'];
}

interface IPublicationRoot { id?: string; files?: IAiPluginVersion['files'] }

/** Замкнутый граф проверяется до записи под общей блокировкой; head не заменяет точный снимок. */
export async function assertPublicationDependencies(client: PoolClient, pins: IDependencyPin[] = [], root: IPublicationRoot = {}): Promise<void> {
    const selected = new Map<string, IDependencyPin>();
    const visiting = new Set<string>();
    let files = root.files?.length ?? 0;
    let bytes = (root.files ?? []).reduce((sum, file) => sum + Buffer.byteLength(file.content ?? '', 'utf8'), 0);
    const assertBudget = () => {
        if (selected.size + 1 > 20 || files > 200 || bytes > 16 * 1024 * 1024) {
            throw new ConflictException('Комплект превышает лимит: 20 инструментов, 200 файлов или 16 МиБ. Разделите зависимости до публикации.');
        }
    };
    const visit = async (pin: IDependencyPin): Promise<void> => {
        const key = pin.kind + ':' + pin.id;
        if (pin.id === root.id || visiting.has(key)) {
            throw new ConflictException('Зависимости образуют цикл. Выберите версии без ссылки на публикуемый инструмент.');
        }
        const known = selected.get(key);
        if (known) {
            if (known.version !== pin.version || known.manifest !== pin.manifest) {
                throw new ConflictException('В комплекте требуются несовместимые версии одной зависимости. Выберите согласованные точные версии.');
            }
            return;
        }
        selected.set(key, pin); assertBudget();
        const result = await client.query<IDependencyVersion>(
            `SELECT p.id,p.name,p.kind,v.files,v.config,v.metadata FROM ai_plugins p
             JOIN ai_plugin_versions v ON v.ai_plugin_id=p.id AND v.version=$2 WHERE p.id=$1 FOR KEY SHARE OF p`,
            [pin.id, pin.version],
        );
        const saved = result.rows[0];
        const conflict = () => new ConflictException('Закреплённая зависимость недоступна или изменилась: ' + pin.id + '. Выберите точную версию заново.');
        if (!saved || (saved.metadata?.kind ?? saved.kind) !== pin.kind) { throw conflict(); }
        let dependencies: IDependencyPin[];
        try {
            dependencies = normalizeDependencyPins(saved.metadata?.dependencies);
            const config = dependencies.length ? { ...saved.config, extra: { ...saved.config?.extra,
                requirements: { mcp: [], plugins: [], dependencies } } } : saved.config;
            const pkg = buildPackage({ id: saved.id, name: saved.name, kind: pin.kind, version: pin.version },
                saved.files.map(file => ({ path: file.path, content: file.content ?? '' })), '', config);
            if (pkg.manifest.sha256 !== pin.manifest) { throw conflict(); }
            assertInstallablePackage(pkg);
            files += pkg.files.length;
            bytes += pkg.files.reduce((sum, file) => sum + file.size, 0);
        } catch { throw conflict(); }
        assertBudget(); visiting.add(key);
        for (const dependency of dependencies) { await visit(dependency); }
        visiting.delete(key);
    };
    assertBudget();
    for (const pin of pins) { await visit(pin); }
}
