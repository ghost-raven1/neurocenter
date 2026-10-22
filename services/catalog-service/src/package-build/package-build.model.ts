import {validateUploadBuildSource,type UploadBuildSource,type PinnedUploadSource} from '../source-upload/source-upload.model';
import { BadRequestException } from '@nestjs/common';
import { packageFiles, publicationHash, filePath } from '../publication/publication-validation';
import { TARGETS } from '../../../shared/runtime-artifacts.cjs';
import { validateRepositorySource, type RepositoryInput, type RepositorySource } from '../../../shared/repository-source.cjs';
import { isSourceEntrypoint } from '../../../shared/source-entrypoint.cjs';
import {inspectSkillSource} from './skill-source';
import type {SkillSourceFile} from '../../../shared/skill-source.cjs';
import {validateBuildPublication,type BuildPublicationTarget,type PinnedBuildPublication} from './publication-target';

export type BuildState = 'QUEUED' | 'RUNNING' | 'CANCELLING' | 'CANCELLED' | 'SUCCEEDED' | 'FAILED';
export interface BuildSourceNpm { type: 'npm'; specifier: string; entrypoint?: string }
export interface BuildSourceFiles { type: 'files'; files: SkillSourceFile[]; entrypoint: string; args?: string[] }
export interface BuildInput {requestKey: string; kind: 'mcp' | 'plugin' | 'skill'; name: string; description: string; tags?: string[]; targets?: string[]; publication?:BuildPublicationTarget; source: BuildSourceNpm | BuildSourceFiles | RepositoryInput | UploadBuildSource}
export interface BuildConfiguration extends Omit<BuildInput, 'requestKey' | 'source' | 'publication'> {publication?:PinnedBuildPublication;targets: string[]; tags: string[]; source: BuildSourceFiles | RepositorySource | PinnedUploadSource | (BuildSourceNpm & {package: string; version: string; entrypoint: string; recommendedKind?: 'mcp' | 'plugin'; supportedTargets?: string[]})}
export interface BuildResult {catalogId: string; name: string; version: number; kind?:'skill';assetId?:string;sourceVersion?:string;sourceSha256?:string}
export interface BuildRow {id: string; actor: string; request_key: string; request_hash: string; config: BuildConfiguration; state: BuildState; percent: number; message: string; result: BuildResult | null; error: string | null; created_at: string; updated_at: string; publication_started_at?: string | null;execution_nonce?:string|null;execution_host?:string|null;execution_pid?:number|null;execution_started?:boolean}
export const buildView = (row: BuildRow) => ({id: row.id, requestKey:row.request_key, publicationStartedAt:row.publication_started_at??null, name: row.config?.name, operationId: 'tool-build-' + row.id, state: row.state, percent: row.percent,
    message: row.message, result: row.result, error: row.error, createdAt: row.created_at, updatedAt: row.updated_at});
export const requestHash = (input: BuildInput) => publicationHash({...input, requestKey: undefined});
export const validId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, label: string, max: number) => {
    if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) { throw new BadRequestException(`${label}: нужен текст до ${max} символов.`); }
    return value.trim();
};

/** В задании сохраняются только исходники и декларация; команды и секреты сервера не принимаются. */
export function validateBuildInput(raw: unknown): BuildInput & {targets: string[]; tags: string[]} {
    if (!object(raw) || Object.keys(raw).some(key => !['requestKey', 'kind', 'name', 'description', 'tags', 'targets', 'source','publication'].includes(key))
        || !validId(raw.requestKey) || !['mcp', 'plugin','skill'].includes(String(raw.kind)) || !object(raw.source)) { throw new BadRequestException('Нужны ключ запроса UUID, тип инструмента и источник npm, repository или files.'); }
    const name = text(raw.name, 'Название', 128);
    if (typeof raw.description !== 'string' || !raw.description.trim() || raw.description.length > 2000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(raw.description)) {throw new BadRequestException('Описание: нужен текст до 2000 символов.');}
    const description = raw.description.trim();
    if (/[/\\]/.test(name) || /^ai-plug-/i.test(name)) { throw new BadRequestException('Название содержит зарезервированный префикс или разделитель пути.'); }
    const targets = raw.targets ?? TARGETS;
    if (!Array.isArray(targets) || !targets.length || targets.length > 8 || new Set(targets).size !== targets.length || targets.some(target => !TARGETS.includes(target))) { throw new BadRequestException('Выберите поддерживаемые платформы без повторов.'); }
    if (raw.tags !== undefined && (!Array.isArray(raw.tags) || raw.tags.length > 20)) { throw new BadRequestException('Укажите до 20 тегов.'); }
    const tags = [...new Set(((raw.tags ?? []) as unknown[]).map(tag => text(tag, 'Тег', 40)))];
    const publication=validateBuildPublication(raw.publication),base={requestKey:raw.requestKey,kind:raw.kind as BuildInput['kind'],name,description,tags,targets:[...targets],...(publication?{publication}:{})};
    const source = raw.source;
    if(raw.kind==='skill'&&!['files','repository'].includes(String(source.type)))throw new BadRequestException('Для скилла выберите папку, архив исходников или репозиторий GitHub с SKILL.md.');
    if (source.type === 'upload') {return {...base,source:validateUploadBuildSource(source)};}
    if (source.type === 'repository') {
        try {return {...base,source: validateRepositorySource(source, {pinned: false})};}
        catch (error) {throw new BadRequestException(error instanceof Error ? error.message : 'Некорректный источник GitHub.');}
    }
    if (source.type === 'npm') {
        if (Object.keys(source).some(key => !['type', 'specifier', 'entrypoint'].includes(key))) { throw new BadRequestException('У npm поддерживаются только specifier и entrypoint.'); }
        const specifier = text(source.specifier, 'npm-пакет', 256);
        const entrypoint = source.entrypoint === undefined ? undefined : filePath(source.entrypoint);
        if (entrypoint && !isSourceEntrypoint(entrypoint)) { throw new BadRequestException('Нужен исполняемый JS/TS-файл запуска npm-пакета, без деклараций типов.'); }
        return {...base,source: {type: 'npm', specifier, ...(entrypoint ? {entrypoint} : {})}};
    }
    if (source.type !== 'files' || Object.keys(source).some(key => !['type', 'files', 'entrypoint', 'args'].includes(key))) { throw new BadRequestException('Источник files принимает files, entrypoint и args.'); }
    const entrypoint = filePath(source.entrypoint);
    if(raw.kind==='skill'){
        if(!/(?:^|\/)SKILL\.md$/.test(entrypoint)||source.args!==undefined)throw new BadRequestException('Скилл использует SKILL.md без команды запуска и args.');
        inspectSkillSource(source.files as SkillSourceFile[],{name,description,entrypoint});
        const files=(source.files as SkillSourceFile[]).map(({path,content,encoding})=>({path,content,...(encoding?{encoding}:{})}));
        return {...base,kind:'skill',source:{type:'files',files,entrypoint}};
    }
    if(Array.isArray(source.files)&&source.files.some(file=>object(file)&&file.encoding!==undefined))throw new BadRequestException('MCP и плагины принимают текстовые исходники без base64.');
    const files = packageFiles(source.files).map(({path, content}) => ({path, content: content!}));
    if (!isSourceEntrypoint(entrypoint) || !files.some(file => file.path === entrypoint && file.content.trim())) { throw new BadRequestException('Выберите непустой JS/TS-файл запуска из загруженных файлов, без деклараций типов.'); }
    if (source.args !== undefined && (!Array.isArray(source.args) || source.args.length > 64 || source.args.some(arg => typeof arg !== 'string' || arg.length > 4096 || /[\x00-\x1f\x7f]/.test(arg)))) { throw new BadRequestException('args: до 64 строк без управляющих символов.'); }
    return {...base,source: {type: 'files', files, entrypoint, ...(source.args ? {args: source.args as string[]} : {})}};
}
