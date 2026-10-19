import { BadRequestException } from '@nestjs/common';
import type { IModelCreate, IModelUpdate, TModelCapability } from './model.types';

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

/** Модель загружается только из реестра Ollama; произвольный URL и неявный latest не принимаются. */
export function validateModelCreate(value: unknown): Required<IModelCreate> {
    const body = record(value);
    fields(body, ['name', 'description', 'capability', 'model', 'dimension']);
    if (!capabilities.includes(body.capability as TModelCapability)) { throw new BadRequestException('Выберите назначение модели: embedding, vision или chat.'); }
    if (typeof body.model !== 'string' || body.model.length > 200 || /[\x00-\x20\x7f]/.test(body.model) || !modelName.test(body.model)) {
        throw new BadRequestException('Укажите имя модели Ollama с явным тегом, например qwen3:4b. Адрес реестра задавать нельзя.');
    }
    let dimension: number | null = null;
    if (body.dimension !== undefined && body.dimension !== null) {
        if (body.capability !== 'embedding' || !Number.isSafeInteger(body.dimension) || Number(body.dimension) < 1 || Number(body.dimension) > 16384) {
            throw new BadRequestException('Размерность задаётся только для embedding-модели: целое число от 1 до 16384.');
        }
        dimension = Number(body.dimension);
    }
    return { name: name(body.name), description: description(body.description ?? ''), capability: body.capability as TModelCapability, model: body.model, dimension };
}

/** Техническое имя и назначение опубликованной модели остаются неизменными для всех проектов. */
export function validateModelUpdate(value: unknown): IModelUpdate {
    const body = record(value);
    fields(body, ['expectedRevision', 'name', 'description']);
    return { expectedRevision: expectedModelRevision(body.expectedRevision),
        ...(body.name !== undefined ? { name: name(body.name) } : {}),
        ...(body.description !== undefined ? { description: description(body.description) } : {}) };
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
