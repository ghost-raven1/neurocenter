import { BadRequestException } from '@nestjs/common';
import type { IModel } from './model.types';
import type { IRemoteModelOptions } from './remote-model.types';
import { normalizeAdapterParameters } from '../../../shared/adapter-parameters.cjs';

export const REMOTE_MODEL_TIMEOUT_MS = 90000;
const limits = {
    temperature: { min: 0, max: 2, integer: false },
    topP: { min: 0, max: 1, integer: false },
    maxOutputTokens: { min: 1, max: 32768, integer: true },
    contextWindow: { min: 128, max: 2097152, integer: true },
} as const;

/** Validates owned settings and bounded private JSON; adapter execution protects transport and control fields. */
export function remoteModelOptions(value: unknown): IRemoteModelOptions {
    if (value === undefined) return {};
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new BadRequestException('Параметры модели должны быть объектом.');
    const result: IRemoteModelOptions = {};
    for (const [key, entry] of Object.entries(value)) {
        if (key === 'providerParameters') {
            try {
                result.providerParameters = normalizeAdapterParameters(entry);
            } catch (cause) {
                throw new BadRequestException((cause as Error).message);
            }
            continue;
        }
        if (key === 'apiFormat') {
            if (entry !== 'chat-completions' && entry !== 'responses')
                throw new BadRequestException('Выберите Chat Completions или Responses API.');
            result.apiFormat = entry;
            continue;
        }
        if (key === 'reasoningEffort') {
            if (
                !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(String(entry)) ||
                typeof entry !== 'string'
            )
                throw new BadRequestException('Укажите поддерживаемый уровень рассуждений.');
            result.reasoningEffort = entry as IRemoteModelOptions['reasoningEffort'];
            continue;
        }
        if (key === 'store') {
            if (typeof entry !== 'boolean') throw new BadRequestException('Хранение ответа: выберите да или нет.');
            result.store = entry;
            continue;
        }
        if (key === 'responseModel') {
            if (
                typeof entry !== 'string' ||
                !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(entry) ||
                entry.includes('://')
            )
                throw new BadRequestException('Укажите точный идентификатор модели в ответе API.');
            result.responseModel = entry;
            continue;
        }
        if (key === 'tokenLimitParameter') {
            if (entry !== 'max_tokens' && entry !== 'max_completion_tokens')
                throw new BadRequestException('Выберите max_tokens или max_completion_tokens.');
            result.tokenLimitParameter = entry;
            continue;
        }
        if (!Object.prototype.hasOwnProperty.call(limits, key))
            throw new BadRequestException('Неизвестный параметр модели: ' + key + '.');
        const name = key as keyof typeof limits,
            limit = limits[name];
        if (
            typeof entry !== 'number' ||
            !Number.isFinite(entry) ||
            entry < limit.min ||
            entry > limit.max ||
            (limit.integer && !Number.isSafeInteger(entry))
        ) {
            throw new BadRequestException(
                `Параметр ${key}: допустимо ${limit.integer ? 'целое число ' : 'число '}от ${limit.min} до ${limit.max}.`,
            );
        }
        result[name] = entry;
    }
    return result;
}

/** OpenAI contextWindow declares the server budget; Ollama also receives num_ctx. */
export function assertRemoteModelOptions(
    model: Pick<IModel, 'runtime' | 'capability'>,
    options: IRemoteModelOptions,
): void {
    if (
        ['responseModel', 'tokenLimitParameter', 'apiFormat', 'reasoningEffort', 'store'].some(
            (key) => options[key as keyof IRemoteModelOptions] !== undefined,
        ) &&
        model.runtime !== 'remote-openai'
    )
        throw new BadRequestException('Параметры совместимости доступны только для OpenAI API.');
    if ((options.reasoningEffort !== undefined || options.store !== undefined) && options.apiFormat !== 'responses')
        throw new BadRequestException('Уровень рассуждений и хранение ответа требуют Responses API.');
    if (options.apiFormat === 'responses' && options.tokenLimitParameter !== undefined)
        throw new BadRequestException(
            'Responses API использует max_output_tokens; очистите параметр лимита Chat Completions.',
        );
    if (
        model.capability === 'embedding' &&
        Object.keys(options).some((key) => !['responseModel', 'providerParameters'].includes(key))
    )
        throw new BadRequestException('Embedding-модель не принимает параметры генерации текста.');
    if (options.contextWindow !== undefined && !['remote-ollama', 'remote-openai'].includes(model.runtime))
        throw new BadRequestException('Размер контекста подключения задаётся для удалённой модели.');
}

/** Timeout changes transport behavior, so it is kept outside the semantic model pin. */
export function remoteModelTimeout(value: unknown): number {
    if (value === undefined) return REMOTE_MODEL_TIMEOUT_MS;
    if (!Number.isSafeInteger(value) || Number(value) < 1000 || Number(value) > 300000)
        throw new BadRequestException('Таймаут модели: целое число от 1000 до 300000 мс.');
    return Number(value);
}
