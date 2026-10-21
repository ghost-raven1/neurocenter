import type { IModel } from './model.types';
import type { IRemoteModelConnection } from './remote-model.types';
import { isRemoteModel } from './remote-model.types';
import { remoteModelBaseUrl } from './remote-model-validation';
import { assertRemoteModelOptions, remoteModelOptions } from './remote-model-options';
import type { IRemoteModelOptions } from './remote-model.types';

type Json = Record<string, unknown>;
const object = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);
const validVector = (vector: unknown, dimension: number | null): vector is number[] => Array.isArray(vector) && vector.length > 0 && vector.length <= 16384
    && (dimension === null || vector.length === dimension) && vector.every(value => typeof value === 'number' && Number.isFinite(Math.fround(value)))
    && vector.some(value => Math.fround(value) !== 0);

export class RemoteModelError extends Error {
    constructor(readonly kind: 'authorization' | 'rate-limit' | 'unavailable' | 'response', message: string) { super(message); }
}

/** Клиент делает только inference зарегистрированной модели и никогда не следует редиректам. */
export class RemoteModelClient {
    constructor(private readonly options: { fetch?: typeof fetch; timeoutMs?: number; maximumBytes?: number } = {}) {}

    async infer(model: IModel, connection: IRemoteModelConnection, endpoint: 'embed' | 'chat', body: Json, signal?: AbortSignal): Promise<Json> {
        if (!isRemoteModel(model) || !model.modelVersion || connection.modelId !== model.id
            || endpoint === 'embed' && model.capability !== 'embedding' || endpoint === 'chat' && model.capability === 'embedding') {
            throw new RemoteModelError('response', 'Запрос не соответствует удалённой модели.');
        }
        assertRemoteModelOptions(model, remoteModelOptions(connection.options));
        const openai = model.runtime === 'remote-openai';
        const texts = endpoint === 'embed' ? (Array.isArray(body.input) ? body.input : [body.input]) : [];
        if (endpoint === 'embed' && (!texts.length || texts.length > 64 || texts.some(text => typeof text !== 'string' || !text.trim()) || Buffer.byteLength(JSON.stringify(texts)) > 1024 * 1024)) {
            throw new RemoteModelError('response', 'Передайте от 1 до 64 непустых текстов.');
        }
        const dimension = connection.requestDimensions && model.dimension ? { dimensions: model.dimension } : {};
        const payload = endpoint === 'embed' ? { model: model.model, input: texts, ...dimension, ...(openai ? { encoding_format: 'float' } : { truncate: false }) }
            : this.chatBody(model, body, openai, connection.options);
        const route = openai ? endpoint === 'embed' ? '/embeddings' : '/chat/completions' : '/api/' + endpoint;
        const value = await this.request(remoteModelBaseUrl(connection.baseUrl) + route, payload, connection.apiKey, signal, connection.timeoutMs);
        if (value.model !== model.model) { throw new RemoteModelError('response', 'Удалённый API вернул ответ другой модели.'); }
        if (endpoint === 'embed') {
            const vectors = openai ? this.openaiVectors(value, texts.length) : value.embeddings;
            if (!Array.isArray(vectors) || vectors.length !== texts.length || !vectors.every(vector => validVector(vector, model.dimension))
                || vectors.some(vector => vector.length !== vectors[0].length)) { throw new RemoteModelError('response', 'Удалённая модель вернула неполные или несовместимые векторы.'); }
            const usage = openai && object(value.usage) ? value.usage.prompt_tokens : value.prompt_eval_count;
            return { model: model.model, embeddings: vectors, prompt_eval_count: Number.isSafeInteger(usage) && Number(usage) >= 0 ? Number(usage) : 0 };
        }
        if (openai) {
            const choice = Array.isArray(value.choices) && value.choices.length === 1 ? value.choices[0] : undefined;
            if (!object(choice) || choice.index !== 0 || !['stop', 'length'].includes(String(choice.finish_reason)) || !object(choice.message)
                || typeof choice.message.content !== 'string' || !choice.message.content.trim()) { throw new RemoteModelError('response', 'Удалённая модель не завершила ответ.'); }
            const usage = object(value.usage) ? value.usage : {};
            const inputTokens = this.tokens(usage.prompt_tokens), outputTokens = this.tokens(usage.completion_tokens);
            return { model: model.model, done: true, done_reason: choice.finish_reason, message: { role: 'assistant', content: choice.message.content },
                prompt_eval_count: inputTokens, eval_count: outputTokens, usage_reported: inputTokens !== null || outputTokens !== null };
        }
        if (value.done !== true || !['stop', 'length'].includes(String(value.done_reason)) || !object(value.message)
            || typeof value.message.content !== 'string' || !value.message.content.trim()) { throw new RemoteModelError('response', 'Удалённая модель не завершила ответ.'); }
        return { ...value, usage_reported: this.tokens(value.prompt_eval_count) !== null || this.tokens(value.eval_count) !== null };
    }

    private tokens(value: unknown): number | null { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null; }
    private openaiVectors(value: Json, count: number): unknown {
        if (value.object !== 'list' || !Array.isArray(value.data) || value.data.length !== count) { return undefined; }
        const result: unknown[] = [];
        for (const entry of value.data) {
            if (!object(entry) || entry.object !== 'embedding' || !Number.isSafeInteger(entry.index) || Number(entry.index) < 0 || Number(entry.index) >= count
                || Object.prototype.hasOwnProperty.call(result, Number(entry.index))) { return undefined; }
            result[Number(entry.index)] = entry.embedding;
        }
        return result;
    }

    private chatBody(model: IModel, body: Json, openai: boolean, defaults?: IRemoteModelOptions): Json {
        if (!Array.isArray(body.messages) || !body.messages.length) { throw new RemoteModelError('response', 'Передайте сообщения для модели.'); }
        const supplied = object(body.options) ? body.options : {};
        const options = remoteModelOptions({ ...defaults,
            ...(supplied.temperature === undefined ? {} : { temperature: supplied.temperature }),
            ...(supplied.top_p === undefined ? {} : { topP: supplied.top_p }),
            ...(supplied.num_predict === undefined ? {} : { maxOutputTokens: supplied.num_predict }),
            ...(supplied.num_ctx === undefined ? {} : { contextWindow: supplied.num_ctx }) });
        assertRemoteModelOptions(model, options);
        if (!openai) { return { model: model.model, messages: body.messages, stream: false, think: false, options: {
            ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
            ...(options.topP === undefined ? {} : { top_p: options.topP }),
            ...(options.maxOutputTokens === undefined ? {} : { num_predict: options.maxOutputTokens }),
            ...(options.contextWindow === undefined ? {} : { num_ctx: options.contextWindow }) } }; }
        const messages = body.messages.map(message => {
            if (!object(message) || typeof message.content !== 'string' || !['system', 'user', 'assistant'].includes(String(message.role))) { throw new RemoteModelError('response', 'Некорректные сообщения модели.'); }
            if (!Array.isArray(message.images) || !message.images.length) { return { role: message.role, content: message.content }; }
            if (model.capability !== 'vision') { throw new RemoteModelError('response', 'Эта модель не принимает изображения.'); }
            return { role: message.role, content: [{ type: 'text', text: message.content }, ...message.images.map(image => {
                if (typeof image !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(image)) { throw new RemoteModelError('response', 'Некорректное изображение модели.'); }
                const mime = Buffer.from(image, 'base64').subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ? 'png' : 'jpeg';
                return { type: 'image_url', image_url: { url: 'data:image/' + mime + ';base64,' + image } };
            })] };
        });
        return { model: model.model, messages, stream: false,
            ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
            ...(options.topP === undefined ? {} : { top_p: options.topP }),
            ...(options.maxOutputTokens === undefined ? {} : { max_tokens: options.maxOutputTokens }) };
    }

    private async request(url: string, body: Json, apiKey?: string, signal?: AbortSignal, timeoutMs?: number): Promise<Json> {
        signal?.throwIfAborted();
        if (apiKey && (apiKey.length > 8192 || /[\x00-\x20\x7f]/.test(apiKey))) { throw new RemoteModelError('authorization', 'Сохранённый ключ удалённого API некорректен.'); }
        const deadline = AbortSignal.any([AbortSignal.timeout(this.options.timeoutMs ?? timeoutMs ?? 90000), ...(signal ? [signal] : [])]);
        try {
            const response = await (this.options.fetch ?? fetch)(url, { method: 'POST', redirect: 'error', signal: deadline,
                headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: 'Bearer ' + apiKey } : {}) }, body: JSON.stringify(body) });
            if (!response.ok) {
                await response.body?.cancel();
                if (response.status === 401 || response.status === 403) { throw new RemoteModelError('authorization', 'Удалённый API отклонил ключ или доступ к модели.'); }
                if (response.status === 429) { throw new RemoteModelError('rate-limit', 'Удалённый API ограничил запросы. Повторите позже.'); }
                throw new RemoteModelError('unavailable', `Удалённый API недоступен (HTTP ${response.status}).`);
            }
            if (!response.body || !/^application\/(?:[a-z0-9.+-]+\+)?json(?:;|$)/i.test(response.headers.get('content-type') ?? '')) {
                await response.body?.cancel(); throw new RemoteModelError('response', 'Удалённый API вернул неподдерживаемый формат ответа.');
            }
            let size = 0; const chunks: Uint8Array[] = [];
            for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
                size += chunk.length;
                if (size > (this.options.maximumBytes ?? 16 * 1024 * 1024)) { throw new RemoteModelError('response', 'Ответ удалённой модели превышает допустимый размер.'); }
                chunks.push(chunk);
            }
            let value: unknown;
            try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new RemoteModelError('response', 'Удалённый API вернул некорректный JSON.'); }
            if (!object(value) || value.error) { throw new RemoteModelError('response', 'Удалённый API не выполнил запрос.'); }
            return value;
        } catch (cause) {
            signal?.throwIfAborted();
            if (cause instanceof RemoteModelError) { throw cause; }
            throw new RemoteModelError('unavailable', deadline.aborted ? 'Удалённая модель не ответила вовремя.' : 'Не удалось соединиться с удалённым API модели.');
        }
    }
}
