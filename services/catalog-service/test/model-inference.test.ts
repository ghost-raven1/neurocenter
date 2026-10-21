import 'reflect-metadata';
import { EventEmitter } from 'node:events';
import { BadRequestException, ConflictException, ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import type { Request } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { ModelInferenceController, modelInferenceBody } from '../src/models/inference.controller';
import type { ModelsService } from '../src/models/models.service';
import type { OllamaClient } from '../src/models/ollama-client';
import type { IModel } from '../src/models/model.types';
import { projectEmbeddingPin } from '../src/models/project-embedding.validation';

const png = Buffer.from('89504e470d0a1a0a0000', 'hex').toString('base64');
const model = (capability: IModel['capability'] = 'embedding'): IModel => ({
    id: 'model-one', name: 'Модель', description: '', capability, runtime: 'ollama', model: 'qwen3:4b', manifestSha256: null,
    dimension: capability === 'embedding' ? 3 : null, source: 'custom', revision: 1, createdAt: '2026-10-19', updatedAt: '2026-10-19',
});
function harness(capability: IModel['capability'] = 'embedding') {
    const card = model(capability);
    const models = { getUsable: vi.fn(async () => card) };
    const runtime = { infer: vi.fn(async () => ({ model: card.model, embeddings: [[1, 0, -1]], prompt_eval_count: 7 })) };
    const request = new EventEmitter() as EventEmitter & { res: EventEmitter & { writableEnded: boolean } };
    request.res = Object.assign(new EventEmitter(), { writableEnded: false });
    return { models, runtime, request, controller: new ModelInferenceController(models as unknown as ModelsService, runtime as unknown as OllamaClient) };
}

describe('Ограниченный запрос модели', () => {
    it('Фиксирует модель на стороне сервера и отбрасывает произвольные параметры runtime', () => {
        expect(modelInferenceBody('embed', { model: 'attacker:latest', input: 'Текст', truncate: true, keep_alive: -1, options: { num_ctx: 999999 } }))
            .toEqual({ input: ['Текст'], truncate: false });
        expect(modelInferenceBody('chat', { messages: [{ role: 'user', content: 'Привет', tool_calls: [{ command: 'shell' }] }],
            stream: false, options: { temperature: 0.3, num_predict: 50, num_ctx: 999999, numa: true }, think: true }))
            .toEqual({ messages: [{ role: 'user', content: 'Привет' }], think: false, options: { temperature: 0.3, num_predict: 50, num_ctx: 999999 } });
    });
    it.each([null, [], {}, { input: [] }, { input: [''] }, { input: ['ok', 42] }, { input: Array(65).fill('text') }, { input: 'x'.repeat(1024 * 1024) }])('Отклоняет некорректный embedding-запрос %#', value => {
        expect(() => modelInferenceBody('embed', value)).toThrow(BadRequestException);
    });
    it('Переводит OpenAI мультимодальное сообщение в локальные текст и PNG без сетевого URL', () => {
        expect(modelInferenceBody('chat', { messages: [{ role: 'user', content: [{ type: 'text', text: 'Описание' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,' + png } }] }], temperature: 0.2, max_tokens: 64 }, true))
            .toEqual({ messages: [{ role: 'user', content: 'Описание', images: [png] }], think: false, options: { temperature: 0.2, num_predict: 64 } });
    });
    it.each(['https://example.invalid/private.png', 'http://169.254.169.254/data', 'file:///etc/passwd', 'data:image/svg+xml;base64,' + png])('Не передаёт runtime внешний источник изображения %s', url => {
        expect(() => modelInferenceBody('chat', { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url } }] }] }, true)).toThrow(BadRequestException);
    });
    it.each(['YmFk', png + '=', 'not/base64', ''])('Проверяет содержимое и каноническую кодировку изображения %#', image => {
        expect(() => modelInferenceBody('chat', { messages: [{ role: 'user', content: 'Что изображено?', images: [image] }] })).toThrow(BadRequestException);
    });
    it('Ограничивает сообщения, картинки и параметры генерации', () => {
        const message = { role: 'user', content: 'Текст' };
        for (const input of [{ messages: Array(41).fill(message) }, { messages: [{ ...message, role: 'tool' }] },
            { messages: [{ ...message, content: 'x'.repeat(128 * 1024 + 1) }] }, { messages: [{ ...message, images: Array(5).fill(png) }] },
            { messages: [message], options: { num_predict: 32769 } }, { messages: [message], options: { temperature: -1 } },
            { messages: [message], options: { top_p: 1.01 } }, { messages: [message], options: { num_ctx: 2097153 } }]) {
            expect(() => modelInferenceBody('chat', input)).toThrow(BadRequestException);
        }
    });
    it('Сохраняет отсутствие параметров и пропускает только разрешённые явные overrides', () => {
        const messages = [{ role: 'user', content: 'Текст' }];
        expect(modelInferenceBody('chat', { messages })).toEqual({ messages, think: false, options: {} });
        expect(modelInferenceBody('chat', { messages, top_p: 0, max_tokens: 8192 }, true))
            .toEqual({ messages, think: false, options: { top_p: 0, num_predict: 8192 } });
    });
    it.each([true, 'true', 1])('Явно отклоняет неподдерживаемую потоковую передачу %#', stream => {
        expect(() => modelInferenceBody('chat', { stream, messages: [{ role: 'user', content: 'Текст' }] }, true)).toThrow('stream: false');
        expect(() => modelInferenceBody('embed', { stream, input: 'Текст' })).toThrow('stream: false');
    });
});

describe('Права и совместимость inference API', () => {
    it.each(['embed', 'embeddings', 'chat', 'completions'] as const)('Проверяет ожидаемый semantic pin перед %s без подмены модели', async method => {
        const capability = method === 'embed' || method === 'embeddings' ? 'embedding' : 'chat';
        const { controller, runtime, request } = harness(capability), card = model(capability);
        runtime.infer.mockResolvedValue({ model: card.model, embeddings: [[1, 0, -1]], message: { role: 'assistant', content: 'Ответ' }, done_reason: 'stop' } as never);
        const body = capability === 'embedding' ? { input: ['Текст'] } : { messages: [{ role: 'user', content: 'Привет' }] };
        await expect(controller[method](card.id, request as unknown as Request, body, undefined, 'a'.repeat(64))).rejects.toBeInstanceOf(ConflictException);
        expect(runtime.infer).not.toHaveBeenCalled();
        await expect(controller[method](card.id, request as unknown as Request, body, undefined, projectEmbeddingPin(card))).resolves.toBeTruthy();
        expect(runtime.infer).toHaveBeenCalledOnce();
    });
    it.each(['', 'a', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), 42, null, ['a'.repeat(64)], { pin: 'a'.repeat(64) }])('Отклоняет некорректный expectedModelPin %# до runtime', async pin => {
        const { controller, models, runtime, request } = harness('chat');
        await expect(controller.completions('model-one', request as unknown as Request, { messages: [{ role: 'user', content: 'Привет' }] }, undefined, pin as unknown as string)).rejects.toBeInstanceOf(BadRequestException);
        expect(runtime.infer).not.toHaveBeenCalled(); expect(models.getUsable).not.toHaveBeenCalled();
    });
    it('Ожидаемый pin не меняется от оформления карточки, но защищает от новой проверенной удалённой конфигурации', async () => {
        const { controller, models, runtime, request } = harness('chat');
        const original = { ...model('chat'), runtime: 'remote-openai', modelVersion: '1', verificationSha256: 'a'.repeat(64) } as IModel;
        const body = { messages: [{ role: 'user', content: 'Привет' }] }, pin = projectEmbeddingPin(original);
        models.getUsable.mockResolvedValue({ ...original, name: 'Новое имя', description: 'Новое описание', revision: 2 });
        runtime.infer.mockResolvedValue({ message: { role: 'assistant', content: 'Ответ' }, done_reason: 'stop' } as never);
        await expect(controller.completions(original.id, request as unknown as Request, body, undefined, pin)).resolves.toBeTruthy();
        models.getUsable.mockResolvedValue({ ...original, verificationSha256: 'b'.repeat(64), revision: 3 });
        await expect(controller.completions(original.id, request as unknown as Request, body, undefined, pin)).rejects.toBeInstanceOf(ConflictException);
        expect(runtime.infer).toHaveBeenCalledOnce();
    });
    it.each(['rights', 'model'] as const)('Поздний отзыв %s не выдаёт рассчитанный ответ', async change => {
        const { controller, models, runtime, request } = harness();
        runtime.infer.mockImplementation(async () => {
            if (change === 'rights') models.getUsable.mockRejectedValue(new ForbiddenException('Роль отозвана'));
            else models.getUsable.mockResolvedValue({ ...model(), manifestSha256: 'b'.repeat(64) });
            return { model: 'qwen3:4b', embeddings: [[1, 0, -1]], prompt_eval_count: 7 };
        });
        await expect(controller.embeddings('model-one', request as unknown as Request, { input: ['Текст'] })).rejects.toBeInstanceOf(change === 'rights' ? ForbiddenException : ConflictException);
        expect(runtime.infer).toHaveBeenCalledOnce(); expect(models.getUsable).toHaveBeenCalledTimes(2);
    });
    it('Отказ в доступе прекращает обработку до runtime, включая подставленный projectId', async () => {
        const { controller, models, runtime, request } = harness();
        models.getUsable.mockRejectedValue(new ForbiddenException('Недоступная модель'));
        await expect(controller.embeddings('model-one', request as unknown as Request, { input: 'Текст' }, 'prj-other')).rejects.toBeInstanceOf(ForbiddenException);
        expect(models.getUsable).toHaveBeenCalledWith('model-one', request, 'prj-other');
        expect(runtime.infer).not.toHaveBeenCalled();
    });
    it('Несовместимый протокол и некорректный ввод отклоняются до runtime', async () => {
        const { controller, runtime, request } = harness();
        await expect(controller.chat('model-one', request as unknown as Request, { messages: [{ role: 'user', content: 'Привет' }] })).rejects.toBeInstanceOf(BadRequestException);
        await expect(controller.embed('model-one', request as unknown as Request, { input: [] })).rejects.toBeInstanceOf(BadRequestException);
        expect(runtime.infer).not.toHaveBeenCalled();
    });
    it('Преобразует векторы в OpenAI-ответ и возвращает фактическую модель карточки', async () => {
        const { controller, runtime, request } = harness();
        const result = await controller.embeddings('model-one', request as unknown as Request, { model: 'other:latest', input: ['Текст'] });
        expect(result).toEqual({ object: 'list', model: 'qwen3:4b', data: [{ object: 'embedding', index: 0, embedding: [1, 0, -1] }], usage: { prompt_tokens: 7, total_tokens: 7 } });
        expect(runtime.infer).toHaveBeenCalledWith(expect.objectContaining({ model: 'qwen3:4b' }), 'embed', { input: ['Текст'], truncate: false }, expect.any(AbortSignal));
        expect(request.listenerCount('aborted')).toBe(0);
        expect(request.res.listenerCount('close')).toBe(0);
    });
    it('Преобразует завершённый chat в OpenAI-ответ с учётом длины и токенов', async () => {
        const { controller, runtime, request } = harness('chat');
        runtime.infer.mockResolvedValue({ message: { role: 'assistant', content: 'Ответ' }, done_reason: 'length', prompt_eval_count: 7, eval_count: 3 } as never);
        const result = await controller.completions('model-one', request as unknown as Request, { messages: [{ role: 'user', content: 'Привет' }] });
        expect(result).toMatchObject({ object: 'chat.completion', model: 'qwen3:4b', choices: [{ index: 0, message: { role: 'assistant', content: 'Ответ' }, finish_reason: 'length' }], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } });
    });
    it('При разрыве клиента отменяет runtime и удаляет слушатели после отказа', async () => {
        const { controller, runtime, request } = harness();
        runtime.infer.mockImplementation(async (_model, _endpoint, _body, signal: AbortSignal) => {
            await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('Клиент отключился')), { once: true }));
            return {} as never;
        });
        const response = controller.embed('model-one', request as unknown as Request, { input: 'Текст' });
        await Promise.resolve(); await Promise.resolve(); request.emit('aborted');
        await expect(response).rejects.toBeInstanceOf(ServiceUnavailableException);
        expect(request.listenerCount('aborted')).toBe(0);
        expect(request.res.listenerCount('close')).toBe(0);
    });
    it.each(['aborted', 'destroyed'] as const)('Уже закрытый клиент %s не запускает inference после проверки прав', async closed => {
        const { controller, runtime, request } = harness();
        if (closed === 'aborted') Object.assign(request, { aborted: true });
        else Object.assign(request.res, { destroyed: true });
        await expect(controller.embed('model-one', request as unknown as Request, { input: 'Текст' })).rejects.toBeInstanceOf(ServiceUnavailableException);
        expect(runtime.infer).not.toHaveBeenCalled();
        expect(request.listenerCount('aborted')).toBe(0); expect(request.res.listenerCount('close')).toBe(0);
    });
});
