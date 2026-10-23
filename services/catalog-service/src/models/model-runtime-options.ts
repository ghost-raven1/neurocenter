import { BadRequestException } from '@nestjs/common';
import type { IModel } from './model.types';
/** Planning budgets stay with their caller; Codex cannot enforce these Ollama/OpenAI wire options. */
export function automaticModelOptions(model: Pick<IModel, 'runtime'>, defaults: Record<string, unknown>, explicit: Record<string, unknown> = {}): Record<string, unknown> {
    if (model.runtime !== 'device-codex')
        return { ...defaults, ...explicit };
    if (Object.entries(explicit).some(([, value]) => value !== undefined))
        throw new BadRequestException('Codex на компьютере не поддерживает температуру, topP и лимит ответа. Уберите эти параметры агента или выберите другую модель.');
    return {};
}
