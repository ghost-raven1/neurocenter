import { BadRequestException } from '@nestjs/common';
import type { IModelDescriptor, IModelUpdate, IValidatedModelCreate, TModelCapability, TModelRuntime } from './model.types';

const capabilities: readonly TModelCapability[] = ['embedding', 'vision', 'chat'];
const modelName = /^(?:[a-z0-9_-]+\/)?[a-z0-9][a-z0-9._-]*:[a-z0-9][a-z0-9._-]*$/i;

function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { throw new BadRequestException('Передайте данные модели.'); }
    return value as Record<string, unknown>;
}

function fields(body: Record<string, unknown>, allowed: string[]): void {
    if (Object.keys(body).some(key => !allowed.includes(key))) { throw new BadRequestException('В карточке модели есть неподдерживаемые поля.'); }
}

function name(value: unknown): string {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 128 || /[\x00-\x1f\x7f]/.test(value)) {
        throw new BadRequestException('Название модели: от 1 до 128 символов без управляющих знаков.');
    }
    return value.trim();
}

function description(value: unknown): string {
    if (typeof value !== 'string' || value.length > 4000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) {
        throw new BadRequestException('Описание модели: не более 4000 символов.');
    }
    return value.trim();
}

export function expectedModelRevision(value: unknown): number {
    if (!Number.isSafeInteger(value) || Number(value) < 1) { throw new BadRequestException('Передайте expectedRevision текущей карточки модели.'); }
    return Number(value);
}

/** Адрес и секрет удалённого API задаются отдельно; карточка не перенаправляет запросы. */
export function validateModelCreate(value: unknown): IValidatedModelCreate {
    const body = record(value);
    fields(body, ['name', 'description', 'capability', 'model', 'dimension', 'runtime', 'modelVersion']);
    const runtime = body.runtime ?? 'ollama';
    if (!['ollama', 'remote-openai', 'remote-ollama','device-codex'].includes(String(runtime))) { throw new BadRequestException('Выберите управляемый Ollama или поддерживаемое подключение модели.'); }
    if (!capabilities.includes(body.capability as TModelCapability)) { throw new BadRequestException('Выберите назначение модели: embedding, vision или chat.'); }
    if(runtime==='device-codex'&&body.capability==='embedding')throw new BadRequestException('Codex на компьютере поддерживает чат и изображения; embedding недоступен.');
    if (typeof body.model !== 'string' || body.model.length > 200 || /[\x00-\x20\x7f]/.test(body.model)
        || (runtime === 'ollama' ? !modelName.test(body.model) : !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(body.model) || body.model.includes('://'))) {
        throw new BadRequestException('Укажите имя модели Ollama с явным тегом, например qwen3:4b. Адрес реестра задавать нельзя.');
    }
    if (runtime !== 'ollama' && (typeof body.modelVersion !== 'string' || !body.modelVersion.trim() || body.modelVersion.length > 128 || /[\x00-\x1f\x7f]/.test(body.modelVersion))) {
        throw new BadRequestException('Укажите версию удалённой модели или API. Этот идентификатор не подтверждает SHA весов провайдера.');
    }
    if (runtime === 'ollama' && body.modelVersion !== undefined) { throw new BadRequestException('Версия управляемой Ollama задаётся тегом модели.'); }
    let dimension: number | null = null;
    if (body.dimension !== undefined && body.dimension !== null) {
        if (body.capability !== 'embedding' || !Number.isSafeInteger(body.dimension) || Number(body.dimension) < 1 || Number(body.dimension) > 16384) {
            throw new BadRequestException('Размерность задаётся только для embedding-модели: целое число от 1 до 16384.');
        }
        dimension = Number(body.dimension);
    }
    return { name: name(body.name), description: description(body.description ?? ''), capability: body.capability as TModelCapability, model: body.model, dimension,
        runtime: runtime as TModelRuntime, ...(runtime === 'ollama' ? {} : { modelVersion: String(body.modelVersion).trim() }) };
}

/** Проверяет нативный descriptor ассета без deployment URL, ключей и чужого результата probe. */
export function validateModelDescriptor(value: unknown): IModelDescriptor {
    const body = record(value);
    fields(body, ['description', 'capability', 'runtime', 'model', 'manifestSha256', 'dimension', 'source', 'modelVersion', 'verificationSha256']);
    if (!['builtin', 'custom'].includes(String(body.source))) { throw new BadRequestException('Некорректное происхождение модели.'); }
    const { name: _name, ...validated } = validateModelCreate({ name: 'Модель', description: body.description, capability: body.capability,
        runtime: body.runtime, model: body.model, dimension: body.dimension, ...(body.modelVersion === undefined ? {} : { modelVersion: body.modelVersion }) });
    const manifest = body.manifestSha256;
    if (!(manifest === null || typeof manifest === 'string' && /^[a-f0-9]{64}$/.test(manifest))) { throw new BadRequestException('Некорректный SHA манифеста модели.'); }
    if (validated.runtime !== 'ollama' && (manifest !== null || body.verificationSha256 !== null)) {
        throw new BadRequestException('Удалённый ассет не содержит SHA весов или проверки подключения другой площадки.');
    }
    if (validated.runtime === 'ollama' && body.verificationSha256 !== undefined && body.verificationSha256 !== null) { throw new BadRequestException('Управляемая модель закрепляется SHA весов.'); }
    return { ...validated, manifestSha256: manifest, source: body.source as IModelDescriptor['source'],
        ...(validated.runtime === 'ollama' ? {} : { verificationSha256: null }) };
}

/** Техническое изменение удалённого API проходит повторную проверку и создаёт новый immutable pin. */
export function validateModelUpdate(value: unknown): IModelUpdate {
    const body = record(value);
    fields(body, ['expectedRevision', 'name', 'description', 'model', 'modelVersion', 'dimension']);
    if (body.model !== undefined && (typeof body.model !== 'string' || !body.model.trim())) throw new BadRequestException('Укажите идентификатор модели API.');
    if (body.modelVersion !== undefined && (typeof body.modelVersion !== 'string' || !body.modelVersion.trim())) throw new BadRequestException('Укажите версию модели API.');
    if (body.dimension !== undefined && body.dimension !== null && (!Number.isSafeInteger(body.dimension) || Number(body.dimension) < 1 || Number(body.dimension) > 16384)) throw new BadRequestException('Размерность: целое число от 1 до 16384.');
    return { expectedRevision: expectedModelRevision(body.expectedRevision),
        ...(body.name !== undefined ? { name: name(body.name) } : {}),
        ...(body.description !== undefined ? { description: description(body.description) } : {}),
        ...(body.model !== undefined ? { model: String(body.model) } : {}), ...(body.modelVersion !== undefined ? { modelVersion: String(body.modelVersion) } : {}),
        ...(body.dimension === undefined ? {} : { dimension: body.dimension as number | null }) };
}

export function validateModelDelete(value: unknown): number {
    const body = record(value);
    fields(body, ['expectedRevision']);
    return expectedModelRevision(body.expectedRevision);
}

export function validateModelAssignment(value: unknown): string {
    const body = record(value);
    fields(body, ['modelId']);
    return validateModelId(body.modelId);
}

export function validateModelId(value: unknown): string {
    if (typeof value !== 'string' || /[^a-z0-9-]/.test(value) || !/^model-[a-z0-9][a-z0-9-]{0,120}$/.test(value)) { throw new BadRequestException('Выберите модель из каталога.'); }
    return value;
}
