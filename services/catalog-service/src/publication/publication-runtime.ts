import { BadRequestException } from '@nestjs/common';
import type { IAiPluginConfig } from '../catalog/dto';
import { parseLocalConfiguration } from '../devices/mcp-config-schema';
import { normalizeRuntimeArtifacts, validateRuntimeArtifactEntrypoints, type RuntimeArtifact } from '../../../shared/runtime-artifacts.cjs';

/** Публичная публикация принимает декларации поставки и настройки, без произвольных extra и секретных значений. */
export function publicationRuntimeExtra(value: unknown, kind: 'mcp' | 'plugin', transport?: unknown): IAiPluginConfig['extra'] {
    if (value === undefined) { return undefined; }
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).some(key => !['runtimeArtifacts', 'localConfiguration'].includes(key))) {
        throw new BadRequestException('В extra поддерживаются только runtimeArtifacts и localConfiguration. Зависимости задаются отдельно.');
    }
    const source = value as Record<string, unknown>;
    try {
        const artifacts = normalizeRuntimeArtifacts(source.runtimeArtifacts);
        validateRuntimeArtifactEntrypoints(kind, artifacts);
        if (transport === 'remote' && artifacts.length) { throw new Error('Удалённому MCP не нужен локальный готовый комплект.'); }
        const schema = parseLocalConfiguration({ plugin: { kind }, config: { transport, extra: source } });
        return { ...(artifacts.length ? { runtimeArtifacts: artifacts } : {}), ...(schema ? { localConfiguration: schema } : {}) };
    } catch (error) { throw new BadRequestException(error instanceof Error ? error.message : 'Некорректная декларация готового комплекта или локальной настройки.'); }
}

/** Старые необязательные поля не должны противоречить авторитетной платформенной точке входа. */
export function validateArtifactLaunchFields(source: Record<string, unknown>, artifacts: RuntimeArtifact[], localMcp = false): void {
    if (source.entrypoint !== undefined && !artifacts.every(item => item.entrypoint === source.entrypoint)) {
        throw new BadRequestException('Файл запуска задаётся в платформенном descriptor; уберите противоречащий entrypoint.');
    }
    if (localMcp && source.command !== undefined && (source.command !== 'node' || artifacts.some(item => item.executable === true))) {
        throw new BadRequestException('Готовый комплект сам задаёт команду запуска. Внешняя команда и команда node для нативного комплекта не поддерживаются.');
    }
}
