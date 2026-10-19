import {lockedModel} from '../embedding/config.mjs';
import {requestJson} from '../models/http.mjs';
import {managedContainer} from '../embedding/runtime.mjs';
import {visionFixture} from './image-fixture.mjs';

export const observationQuestion = 'Read the digits at the top of the image and identify the color of the square at the bottom. Return only a JSON object with string fields number and color. Use an English lowercase color name.';
export const observationSchema = {type: 'object', properties: {number: {type: 'string'}, color: {type: 'string', enum: ['red', 'blue', 'green']}}, required: ['number', 'color'], additionalProperties: false};

/** API получает байты выбранной картинки, а не URL, который сервер должен скачивать. */
export function visionRequest(config, {image, mimeType = 'image/png', question, format, maxTokens = 256, protocol = 'ollama', timeout = 300000}) {
    if (config.capability !== 'vision') throw new Error('Для изображений нужен профиль vision.');
    if (!Buffer.isBuffer(image) || !image.length || image.length > 10 * 1024 * 1024) throw new Error('Изображение должно занимать от 1 байта до 10 МиБ.');
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(mimeType)) throw new Error('Поддерживаются PNG, JPEG и WebP.');
    if (typeof question !== 'string' || !question.trim() || question.length > 4000) throw new Error('Вопрос должен содержать от 1 до 4000 символов.');
    if (!Number.isInteger(maxTokens) || maxTokens < 16 || maxTokens > 1024) throw new Error('Лимит ответа должен быть от 16 до 1024 токенов.');
    if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 600000) throw new Error('Таймаут должен быть от 1 до 600 секунд.');
    if (!['ollama', 'openai'].includes(protocol)) throw new Error('Выберите протокол ollama или openai.');
    const base64 = image.toString('base64');
    const body = protocol === 'ollama'
        ? {model: config.lock.model, messages: [{role: 'user', content: question, images: [base64]}], stream: false,
            options: {temperature: 0, num_ctx: 4096, num_predict: maxTokens}, keep_alive: '1m', ...(format ? {format} : {})}
        : {model: config.lock.model, messages: [{role: 'user', content: [{type: 'text', text: question}, {type: 'image_url', image_url: {url: `data:${mimeType};base64,${base64}`}}]}],
            stream: false, temperature: 0, max_tokens: maxTokens,
            ...(format ? {response_format: {type: 'json_schema', json_schema: {name: 'image_observation', strict: true, schema: format}}} : {})};
    return {url: config.baseUrl + (protocol === 'ollama' ? '/api/chat' : '/v1/chat/completions'), body, timeout};
}

/** Пустой или незавершённый HTTP 200 не считается обработанной картинкой. */
export function visionResult(value, model, protocol) {
    const choice = value?.choices?.[0];
    const text = protocol === 'ollama' ? value?.message?.content : choice?.message?.content;
    const reason = protocol === 'ollama' ? value?.done_reason : choice?.finish_reason;
    if (typeof text !== 'string' || !text.trim() || text.length > 32768 || value?.model !== model
        || protocol === 'ollama' && value.done !== true || !['stop', 'length'].includes(reason)) {
        throw new Error('Модель не вернула завершённый текстовый ответ. Повторите запрос.');
    }
    return {model, text: text.trim(), truncated: reason === 'length'};
}

/** Вызывает только принадлежащий проекту runtime и закреплённую vision-модель. */
export async function visionChat(config, input, ensureManaged = managedContainer) {
    const request = visionRequest(config, input);
    await ensureManaged(config);
    const tags = await requestJson(config.baseUrl + '/api/tags');
    if (!lockedModel(tags, config.lock)) throw new Error('Vision-модель не подготовлена. Выполните npm run vision:up.');
    const value = await requestJson(request.url, {body: request.body, timeout: request.timeout});
    return visionResult(value, config.lock.model, input.protocol || 'ollama');
}

/** Проверка требует прочитать число и цвет собственной картинки, не перечисленные в вопросе. */
export async function probeVision(config, ensureManaged = managedContainer) {
    const metadata = await requestJson(config.baseUrl + '/api/show', {body: {model: config.lock.model}, timeout: 30000});
    if (!Array.isArray(metadata.capabilities) || !metadata.capabilities.includes('vision')) throw new Error('Модель не заявляет поддержку изображений.');
    const result = await visionChat(config, {image: visionFixture(), question: observationQuestion, format: observationSchema, maxTokens: 64}, ensureManaged);
    let observation;
    try {observation = JSON.parse(result.text);} catch {throw new Error('Модель не распознала тестовую картинку в заданном формате.');}
    if (result.truncated || !observation || typeof observation !== 'object' || Array.isArray(observation)
        || Object.keys(observation).length !== 2 || observation.number !== '42' || observation.color !== 'red') throw new Error('Модель неверно распознала число или цвет тестовой картинки.');
    return {visionVerified: true, observation};
}
