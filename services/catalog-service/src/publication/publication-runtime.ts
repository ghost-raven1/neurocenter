import { BadRequestException } from '@nestjs/common';
import type { IAiPluginConfig } from '../catalog/dto';
import { parseLocalConfiguration } from '../devices/mcp-config-schema';
import { normalizeRuntimeArtifacts, validateRuntimeArtifactEntrypoints, type RuntimeArtifact, type RuntimeArtifactEntry } from '../../../shared/runtime-artifacts.cjs';
import {localRagUi} from '../../../shared/rag-ui-contract.cjs';
import {localRagCore} from '../../../shared/rag-core-contract.cjs';
import {MEMORY_RECIPE,memoryRecipeSupported} from '../../../shared/project-learning-memory-sync.cjs';
import {supportsLearningQuirks} from '../../../shared/project-learning-quirks.cjs';
const codexPin=require('../../../shared/codex-connector-pin.json') as {sourceCommit:string;version:string;sdkVersion:string};

/** Публичная публикация принимает декларации поставки и настройки, без произвольных extra и секретных значений. */
export function publicationRuntimeExtra(value: unknown, kind: 'mcp' | 'plugin', transport?: unknown): IAiPluginConfig['extra'] {
    if (value === undefined) { return undefined; }
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).some(key => !['runtimeArtifacts', 'localConfiguration', 'localUi', 'ragCore', 'hostedEmbedding','hostedMcp','researchMcp','codexConnector','learningMemory','learningQuirks'].includes(key))) {
        throw new BadRequestException('В extra поддерживаются декларации runtime, локальной настройки, Codex и совместимого самообучения. Зависимости задаются отдельно.');
    }
    const source = value as Record<string, unknown>;
    try {
        const artifacts = normalizeRuntimeArtifacts(source.runtimeArtifacts);
        validateRuntimeArtifactEntrypoints(kind, artifacts);
        const codex=source.codexConnector as Record<string,unknown>|undefined;
        // This declaration preserves the producer pin; separate build provenance grants connector capability.
        if(codex!==undefined&&(!codex||typeof codex!=='object'||Array.isArray(codex)||kind!=='plugin'||!artifacts.length
            ||Object.keys(codex).sort().join(',')!=='authOnly,schemaVersion,sdkVersion,sourceCommit,version'
            ||codex.schemaVersion!==1||codex.authOnly!==true||codex.sourceCommit!==codexPin.sourceCommit||codex.version!==codexPin.version||codex.sdkVersion!==codexPin.sdkVersion))
            throw new Error('codexConnector требует закреплённый auth-only плагин Codex с готовыми платформенными комплектами.');
        if (transport === 'remote' && artifacts.length) { throw new Error('Удалённому MCP не нужен локальный готовый комплект.'); }
        if(source.hostedMcp!==undefined&&(typeof source.hostedMcp!=='boolean'||kind!=='mcp'||transport==='remote'||!artifacts.length))throw new Error('hostedMcp требует локальный MCP с готовым комплектом Gateway.');
        const research=source.researchMcp as {adapter?:unknown;tools?:unknown}|undefined;
        if(research!==undefined&&(!research||typeof research!=='object'||Array.isArray(research)||Object.keys(research).some(key=>!['adapter','tools'].includes(key))
            ||research.adapter!=='exa'||!Array.isArray(research.tools)||research.tools.length!==2||!['web_search_exa','web_fetch_exa'].every(name=>(research.tools as unknown[]).includes(name))
            ||source.hostedMcp!==true))throw new Error('researchMcp требует одобренные search/fetch инструменты Exa и hostedMcp: true.');
        const schema = parseLocalConfiguration({ plugin: { kind }, config: { transport, extra: source } });
        const ui=localRagUi({schemaVersion:5,plugin:{kind},config:{transport,extra:{...source,runtimeArtifacts:artifacts}}});
        const core=localRagCore({schemaVersion:5,plugin:{kind},config:{transport,extra:{...source,runtimeArtifacts:artifacts}}});
        const declaration={schemaVersion:5,plugin:{kind},config:{transport,entrypoint:artifacts[0]?.entrypoint,extra:source}};
        const memory=source.learningMemory,quirks=source.learningQuirks as Record<string,unknown>|undefined;
        if(memory!==undefined&&(!artifacts.length||artifacts.some(item=>item.executable||item.entrypoint!=='entrypoint.mjs')||!memoryRecipeSupported(declaration)))
            throw new Error('learningMemory требует точный ABI локального MCP Memory и готовые платформенные комплекты.');
        if(quirks!==undefined&&(!artifacts.length||!ui||!supportsLearningQuirks(declaration)))
            throw new Error('learningQuirks требует закреплённый источник OpenCodeRAG с локальным интерфейсом и готовыми комплектами.');
        const hosted = source.hostedEmbedding;
        const marker = hosted as {schemaVersion?: unknown;profileSchemaVersion?: unknown;reindexSchemaVersion?:unknown}|undefined;
        if (hosted !== undefined && (!hosted || typeof hosted !== 'object' || Array.isArray(hosted)
            || Object.keys(hosted).some(key => !['schemaVersion','profileSchemaVersion','reindexSchemaVersion'].includes(key)) || marker?.schemaVersion !== 1 || marker?.reindexSchemaVersion !== undefined && marker.reindexSchemaVersion !== 1
            || ('profileSchemaVersion' in hosted && marker?.profileSchemaVersion !== 2) || !core)) {
            throw new Error('hostedEmbedding требует поддерживаемый протокол закреплённого ядра OpenCodeRAG.');
        }
        return { ...(artifacts.length ? { runtimeArtifacts: artifacts } : {}), ...(schema ? { localConfiguration: schema } : {}), ...(ui?{localUi:ui}:{}),
            ...(source.ragCore!==undefined?{ragCore:core}:{}),
            ...(memory!==undefined?{learningMemory:{...MEMORY_RECIPE}}:{}),...(quirks?{learningQuirks:{...quirks}}:{}),
            ...(codex?{codexConnector:{schemaVersion:1,sourceCommit:codexPin.sourceCommit,version:codexPin.version,sdkVersion:codexPin.sdkVersion,authOnly:true}}:{}),
            ...(source.hostedMcp!==undefined?{hostedMcp:source.hostedMcp}:{}),...(research?{researchMcp:{adapter:'exa',tools:['web_search_exa','web_fetch_exa']}}:{}),
            ...(hosted !== undefined ? {hostedEmbedding: {schemaVersion: 1,...(marker?.profileSchemaVersion === 2 ? {profileSchemaVersion: 2} : {}),...(marker?.reindexSchemaVersion===1?{reindexSchemaVersion:1}:{})}} : {}) };
    } catch (error) { throw new BadRequestException(error instanceof Error ? error.message : 'Некорректная декларация готового комплекта или локальной настройки.'); }
}

/** The fixed engine/UI entrypoint must physically belong to every verified platform archive. */
export function assertLocalUiInventory(config:IAiPluginConfig|null|undefined,kind:string,entries:RuntimeArtifactEntry[]):void{
    const core=localRagCore({schemaVersion:5,plugin:{kind},config});
    if(core&&!entries.some(entry=>entry.path===core.entrypoint&&entry.size>0)){
        throw new BadRequestException('Точка входа OpenCodeRAG отсутствует или пуста в описи готового комплекта.');
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
