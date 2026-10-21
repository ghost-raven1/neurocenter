import { BadRequestException, Body, ConflictException, Controller, HttpException, Inject, Param, Post, Query, Req, ServiceUnavailableException } from '@nestjs/common';
import type { Request } from 'express';
import { ModelsService } from './models.service';
import { ModelRuntime, type IModelInferenceRuntime } from './model-runtime';
import { projectEmbeddingPin } from './project-embedding.validation';
import { remoteModelOptions } from './remote-model-options';

type Json = Record<string, unknown>;
const object = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);
const invalid = (): never => { throw new BadRequestException('Некорректный запрос модели. Допустимы текст, локальные PNG/JPEG и ограниченный размер запроса.'); };

/** Сетевые URL картинок и произвольные параметры runtime не проходят в общий хостинг. */
export function modelInferenceBody(endpoint: 'embed' | 'chat', input: unknown, openai = false): Json {
    if (!object(input) || Buffer.byteLength(JSON.stringify(input)) > 8 * 1024 * 1024) { return invalid(); }
    if (input.stream !== undefined && input.stream !== false) { throw new BadRequestException('Этот endpoint возвращает полный ответ. Передайте stream: false.'); }
    if (endpoint === 'embed') {
        const texts = typeof input.input === 'string' ? [input.input] : input.input;
        if (!Array.isArray(texts) || !texts.length || texts.length > 64 || texts.some(text => typeof text !== 'string' || !text.trim())
            || Buffer.byteLength(JSON.stringify(texts)) > 1024 * 1024) { return invalid(); }
        return { input: texts, truncate: false };
    }
    if (!Array.isArray(input.messages) || !input.messages.length || input.messages.length > 40) { return invalid(); }
    let imagesCount = 0;
    const messages = input.messages.map(message => {
        if (!object(message) || !['user', 'assistant', 'system'].includes(String(message.role))) { return invalid(); }
        let content = message.content;
        const images: string[] = [];
        if (openai && Array.isArray(content)) {
            const text: string[] = [];
            for (const part of content) {
                if (!object(part)) { return invalid(); }
                if (part.type === 'text' && typeof part.text === 'string') { text.push(part.text); }
                else if (part.type === 'image_url' && object(part.image_url) && typeof part.image_url.url === 'string') {
                    const match = /^data:image\/(?:png|jpeg);base64,([A-Za-z0-9+/]+=*)$/.exec(part.image_url.url);
                    if (!match) { return invalid(); }
                    images.push(match[1]);
                } else { return invalid(); }
            }
            content = text.join('\n');
        } else if (message.images !== undefined) {
            if (!Array.isArray(message.images) || message.images.some(image => typeof image !== 'string')) { return invalid(); }
            images.push(...message.images as string[]);
        }
        if (typeof content !== 'string' || Buffer.byteLength(content) > 128 * 1024) { return invalid(); }
        for (const image of images) {
            if (!image.length || image.length > 4 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image)) { return invalid(); }
            const bytes = Buffer.from(image, 'base64');
            if (bytes.toString('base64') !== image || !(bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) || bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex')))) { return invalid(); }
        }
        imagesCount += images.length;
        if (imagesCount > 4) { return invalid(); }
        return { role: message.role, content, ...(images.length ? { images } : {}) };
    });
    const options = object(input.options) ? input.options : {};
    const temperature = openai ? input.temperature : options.temperature;
    const tokens = openai ? input.max_tokens : options.num_predict;
    const topP = openai ? input.top_p : options.top_p;
    const contextWindow = openai ? undefined : options.num_ctx;
    remoteModelOptions({ ...(temperature === undefined ? {} : { temperature }), ...(tokens === undefined ? {} : { maxOutputTokens: tokens }),
        ...(topP === undefined ? {} : { topP }), ...(contextWindow === undefined ? {} : { contextWindow }) });
    return { messages, think: false, options: { ...(temperature === undefined ? {} : { temperature }), ...(tokens === undefined ? {} : { num_predict: tokens }),
        ...(topP === undefined ? {} : { top_p: topP }), ...(contextWindow === undefined ? {} : { num_ctx: contextWindow }) } };
}

/** Модель выбирается по карточке, права проверяются заново перед каждым inference-запросом. */
@Controller('api/models')
export class ModelInferenceController {
    constructor(private readonly models: ModelsService, @Inject(ModelRuntime) private readonly runtime: IModelInferenceRuntime) {}
    @Post(':id/ollama/api/embed')
    embed(@Param('id') id: string, @Req() request: Request, @Body() input: unknown, @Query('projectId') projectId?: string, @Query('expectedModelPin') expectedModelPin?: string) {
        return this.run(id, request, input, 'embed', false, projectId, expectedModelPin);
    }
    @Post(':id/ollama/api/chat')
    chat(@Param('id') id: string, @Req() request: Request, @Body() input: unknown, @Query('projectId') projectId?: string, @Query('expectedModelPin') expectedModelPin?: string) {
        return this.run(id, request, input, 'chat', false, projectId, expectedModelPin);
    }
    @Post(':id/ollama/v1/embeddings')
    embeddings(@Param('id') id: string, @Req() request: Request, @Body() input: unknown, @Query('projectId') projectId?: string, @Query('expectedModelPin') expectedModelPin?: string) {
        return this.run(id, request, input, 'embed', true, projectId, expectedModelPin);
    }
    @Post(':id/ollama/v1/chat/completions')
    completions(@Param('id') id: string, @Req() request: Request, @Body() input: unknown, @Query('projectId') projectId?: string, @Query('expectedModelPin') expectedModelPin?: string) {
        return this.run(id, request, input, 'chat', true, projectId, expectedModelPin);
    }
    /** Pin снимка UI не позволяет отправить старый диалог в уже изменённую семантику модели. */
    private async run(id: string, request: Request, input: unknown, endpoint: 'embed' | 'chat', openai: boolean, projectId?: string, expectedModelPin?: string) {
        if (expectedModelPin !== undefined && (typeof expectedModelPin !== 'string' || !/^[a-f0-9]{64}$/.test(expectedModelPin))) {
            throw new BadRequestException('Передайте корректный SHA-256 ожидаемой модели.');
        }
        const model = await this.models.getUsable(id, request, projectId);
        const modelPin = projectEmbeddingPin(model);
        if (expectedModelPin !== undefined && expectedModelPin !== modelPin) throw new ConflictException('Модель изменилась. Обновите каталог и начните новый диалог.');
        if (endpoint === 'embed' && model.capability !== 'embedding' || endpoint === 'chat' && model.capability === 'embedding') {
            throw new BadRequestException('Протокол запроса не соответствует модели.');
        }
        const body = modelInferenceBody(endpoint, input, openai);
        const abort = new AbortController();
        const disconnected = () => { abort.abort(); };
        const closed = () => { if (!request.res?.writableEnded) { abort.abort(); } };
        request.on('aborted', disconnected);
        request.res?.on('close', closed);
        try {
            if (request.aborted || request.res?.destroyed) { abort.abort(); }
            abort.signal.throwIfAborted();
            const result = await this.runtime.infer(model, endpoint, body, abort.signal);
            const current = await this.models.getUsable(id, request, projectId);
            if (projectEmbeddingPin(current) !== modelPin) throw new ConflictException('Модель изменилась во время запроса. Обновите подключение.');
            if (!openai) { return result; }
            if (endpoint === 'embed') {
                if (!Array.isArray(result.embeddings)) { throw new Error('Некорректные векторы'); }
                return { object: 'list', model: model.model, data: result.embeddings.map((embedding, index) => ({ object: 'embedding', embedding, index })),
                    usage: { prompt_tokens: Number(result.prompt_eval_count) || 0, total_tokens: Number(result.prompt_eval_count) || 0 } };
            }
            return { id: 'chatcmpl-model-' + Date.now().toString(36), object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: model.model,
                choices: [{ index: 0, message: result.message, finish_reason: result.done_reason === 'length' ? 'length' : 'stop' }],
                usage: { prompt_tokens: Number(result.prompt_eval_count) || 0, completion_tokens: Number(result.eval_count) || 0,
                    total_tokens: (Number(result.prompt_eval_count) || 0) + (Number(result.eval_count) || 0) } };
        } catch (cause) { if (cause instanceof HttpException) throw cause; throw new ServiceUnavailableException('Модель не выполнила запрос. Проверьте состояние хостинга и ограничения модели.'); }
        finally { request.removeListener('aborted', disconnected); request.res?.removeListener('close', closed); }
    }
}
