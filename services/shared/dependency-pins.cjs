'use strict';

/** Проверяет точные ссылки на зависимости без поиска по имени или текущей версии. */
function normalizeDependencyPins(value) {
    if (value === undefined) { return []; }
    if (!Array.isArray(value) || value.length > 20) { throw new TypeError('Зависимости: укажите до 20 точных версий MCP или плагинов.'); }
    const seen = new Set();
    return value.map(pin => {
        if (!pin || typeof pin !== 'object' || Array.isArray(pin)
            || Object.keys(pin).some(key => !['kind', 'id', 'version', 'manifest'].includes(key))
            || !['mcp', 'plugin'].includes(pin.kind)
            || typeof pin.id !== 'string' || !/^ai-plug-[a-z0-9][a-z0-9_-]{0,119}$/.test(pin.id)
            || !Number.isSafeInteger(pin.version) || pin.version < 1
            || typeof pin.manifest !== 'string' || !/^[a-f0-9]{64}$/.test(pin.manifest)) {
            throw new TypeError('Зависимость должна содержать тип MCP/плагин, ID инструмента, точную версию и SHA-256 пакета.');
        }
        const key = pin.kind + ':' + pin.id;
        if (seen.has(key)) { throw new TypeError('Одна зависимость не должна повторяться или требовать разные версии.'); }
        seen.add(key);
        return { kind: pin.kind, id: pin.id, version: pin.version, manifest: pin.manifest };
    }).sort((a, b) => {
        const left = a.kind + ':' + a.id;
        const right = b.kind + ':' + b.id;
        return left === right ? 0 : left < right ? -1 : 1;
    });
}

module.exports = { normalizeDependencyPins };
