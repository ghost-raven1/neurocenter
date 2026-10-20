import { BadRequestException } from '@nestjs/common';
import type { IAiPluginConfig } from '../catalog/dto';
import { parseLocalConfiguration } from '../devices/mcp-config-schema';
import { normalizeRuntimeArtifacts, validateRuntimeArtifactEntrypoints, type RuntimeArtifact, type RuntimeArtifactEntry } from '../../../shared/runtime-artifacts.cjs';
import {localRagUi} from '../../../shared/rag-ui-contract.cjs';

/** Публичная публикация принимает декларации поставки и настройки, без произвольных extra и секретных значений. */
export function publicationRuntimeExtra(value: unknown, kind: 'mcp' | 'plugin', transport?: unknown): IAiPluginConfig['extra'] {
    if (value === undefined) { return undefined; }
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).some(key => !['runtimeArtifacts', 'localConfiguration', 'localUi', 'hostedEmbedding'].includes(key))) {
        throw new BadRequestException('В extra поддерживаются только runtimeArtifacts, localConfiguration, localUi и hostedEmbedding. Зависимости задаются отдельно.');
    }
    const source = value as Record<string, unknown>;
    try {
        const artifacts = normalizeRuntimeArtifacts(source.runtimeArtifacts);
        validateRuntimeArtifactEntrypoints(kind, artifacts);
        if (transport === 'remote' && artifacts.length) { throw new Error('Удалённому MCP не нужен локальный готовый комплект.'); }
        const schema = parseLocalConfiguration({ plugin: { kind }, config: { transport, extra: source } });
        const ui=localRagUi({schemaVersion:5,plugin:{kind},config:{transport,extra:{...source,runtimeArtifacts:artifacts}}});
        const hosted = source.hostedEmbedding;
        const marker = hosted as {schemaVersion?: unknown;profileSchemaVersion?: unknown;reindexSchemaVersion?:unknown}|undefined;
        if (hosted !== undefined && (!hosted || typeof hosted !== 'object' || Array.isArray(hosted)
            || Object.keys(hosted).some(key => !['schemaVersion','profileSchemaVersion','reindexSchemaVersion'].includes(key)) || marker?.schemaVersion !== 1 || marker?.reindexSchemaVersion !== undefined && marker.reindexSchemaVersion !== 1
            || ('profileSchemaVersion' in hosted && marker?.profileSchemaVersion !== 2) || !ui)) {
            throw new Error('hostedEmbedding требует schemaVersion: 1 и необязательный profileSchemaVersion: 2 в закреплённом OpenCodeRAG с localUi.');
        }
        return { ...(artifacts.length ? { runtimeArtifacts: artifacts } : {}), ...(schema ? { localConfiguration: schema } : {}), ...(ui?{localUi:ui}:{}),
            ...(hosted !== undefined ? {hostedEmbedding: {schemaVersion: 1,...(marker?.profileSchemaVersion === 2 ? {profileSchemaVersion: 2} : {}),...(marker?.reindexSchemaVersion===1?{reindexSchemaVersion:1}:{})}} : {}) };
    } catch (error) { throw new BadRequestException(error instanceof Error ? error.message : 'Некорректная декларация готового комплекта или локальной настройки.'); }
}

/** Дополнительная UI-точка обязана входить в проверенную SHA-опись каждого платформенного архива. */
export function assertLocalUiInventory(config:IAiPluginConfig|null|undefined,kind:string,entries:RuntimeArtifactEntry[]):void{
    const ui=localRagUi({schemaVersion:5,plugin:{kind},config});
    if(ui&&!entries.some(entry=>entry.path===ui.entrypoint&&entry.size>0)){
        throw new BadRequestException('Точка входа localUi отсутствует или пуста в описи готового комплекта.');
    }
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
