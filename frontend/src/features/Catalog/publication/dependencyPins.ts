import type { IDependencyPin, IBundlePackage } from '../../../core/api/interfaces';

const idPattern = /^ai-plug-[a-z0-9][a-z0-9_-]{0,119}$/;
const manifestPattern = /^[a-f0-9]{64}$/;

/** Проверяет точные версии до публикации; свободные имена и текущая версия не подставляются. */
export function checkDependencyPins(value: unknown): IDependencyPin[] {
    if (!Array.isArray(value) || value.length > 20) { throw new Error('Выберите до 20 закреплённых зависимостей MCP или плагинов.'); }
    const used = new Set<string>();
    return value.map(raw => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { throw new Error('У зависимости нужны тип, ID, версия и SHA-256.'); }
        const pin = raw as Record<string, unknown>;
        if (Object.keys(pin).some(key => !['kind', 'id', 'version', 'manifest'].includes(key)) || !['mcp', 'plugin'].includes(String(pin.kind)) ||
            typeof pin.id !== 'string' || !idPattern.test(pin.id) || !Number.isSafeInteger(pin.version) || Number(pin.version) < 1 ||
            typeof pin.manifest !== 'string' || !manifestPattern.test(pin.manifest)) {
            throw new Error('У зависимости нужны тип MCP/плагин, ID из каталога, точная версия и SHA-256.');
        }
        const key = `${pin.kind}:${pin.id}`;
        if (used.has(key)) { throw new Error('Один инструмент нельзя закрепить несколько раз. Сначала уберите прежнюю зависимость.'); }
        used.add(key);
        return {kind: pin.kind as IDependencyPin['kind'], id: pin.id, version: Number(pin.version), manifest: pin.manifest};
    }).sort((a, b) => `${a.kind}:${a.id}` === `${b.kind}:${b.id}` ? 0 : `${a.kind}:${a.id}` < `${b.kind}:${b.id}` ? -1 : 1);
}

interface PackageReader { getAiPluginPackage: (id: string, version: number) => Promise<IBundlePackage>; }

/** Получает хэш только явно выбранной версии и сверяет ответ с выбранным инструментом. */
export async function readDependencyPin(api: PackageReader, asset: {id: string; kind: IDependencyPin['kind']}, version: number): Promise<IDependencyPin> {
    if (!idPattern.test(asset.id) || !Number.isSafeInteger(version) || version < 1) { throw new Error('Выберите инструмент и конкретную версию из списка.'); }
    const pkg = await api.getAiPluginPackage(asset.id, version);
    if (pkg?.plugin?.id !== asset.id || pkg.plugin.kind !== asset.kind || pkg.plugin.version !== version || !manifestPattern.test(pkg?.manifest?.sha256 ?? '')) {
        throw new Error('Сервер вернул другой инструмент, версию или неполный хэш. Зависимость не добавлена.');
    }
    return {kind: asset.kind, id: asset.id, version, manifest: pkg.manifest.sha256};
}

/** Добавление не заменяет уже закреплённую версию и не создаёт прямую ссылку на себя. */
export function appendDependencyPin(value: IDependencyPin[], pin: IDependencyPin, ownId?: string): IDependencyPin[] {
    if (pin.id === ownId) { throw new Error('Инструмент не может зависеть от самого себя.'); }
    return checkDependencyPins([...value, pin]);
}
