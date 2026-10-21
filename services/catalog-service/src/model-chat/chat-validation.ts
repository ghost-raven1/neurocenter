import { BadRequestException, ConflictException } from '@nestjs/common';
import { createHash } from 'node:crypto';

export const CHAT_FILE_BYTES = 10 * 1024 ** 2, CHAT_TOTAL_BYTES = 50 * 1024 ** 2, CHAT_TEXT_BYTES = 100 * 1024;
export const chatHash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const chatChanged = (): ConflictException => new ConflictException('Диалог изменился. Обновите его и повторите действие.');
export function chatBody(value: unknown, allowed: string[]): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new BadRequestException('Некорректные параметры диалога.');
    return value as Record<string, unknown>;
}
export function chatUuid(value: unknown): string {
    if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)) throw new BadRequestException('Некорректный идентификатор диалога или запроса.');
    return value.toLowerCase();
}
export function chatRevision(value: unknown): number {
    if (!Number.isSafeInteger(value) || Number(value) < 1) throw new BadRequestException('Нужна актуальная ревизия диалога.');
    return Number(value);
}
export function chatPin(value: unknown): string {
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new BadRequestException('Нужна проверенная версия модели.');
    return value;
}
export function chatTitle(value: unknown): string {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 128 || /[\x00-\x1f\x7f]/.test(value)) throw new BadRequestException('Название диалога: от 1 до 128 символов.');
    return value.trim();
}
export function chatPrompt(value: unknown, allowEmpty = false): string {
    if (typeof value !== 'string' || value.includes('\0') || !allowEmpty && !value.trim() || Buffer.byteLength(value) > 128 * 1024) throw new BadRequestException('Сообщение должно содержать до 128 КиБ текста.');
    return value;
}
export function chatAttachmentIds(value: unknown): string[] {
    if (!Array.isArray(value) || value.length > 5) throw new BadRequestException('Можно прикрепить до пяти файлов к сообщению.');
    const ids = value.map(chatUuid);
    if (new Set(ids).size !== ids.length) throw new BadRequestException('Файл прикреплён повторно.');
    return ids;
}
export function chatUpload(value: unknown): { name: string; bytes: Buffer; requestId: string; hash: string } {
    const body = chatBody(value, ['name', 'contentBase64', 'requestId']);
    if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 255 || /[\/\\\x00-\x1f\x7f]/.test(body.name)) throw new BadRequestException('Некорректное имя файла.');
    if (typeof body.contentBase64 !== 'string' || body.contentBase64.length > Math.ceil(CHAT_FILE_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.contentBase64)) throw new BadRequestException('Выберите непустой файл размером до 10 МиБ.');
    const bytes = Buffer.from(body.contentBase64, 'base64');
    if (!bytes.length || bytes.length > CHAT_FILE_BYTES || bytes.toString('base64') !== body.contentBase64) throw new BadRequestException('Файл повреждён или превышает 10 МиБ.');
    return { name: body.name.trim(), bytes, requestId: chatUuid(body.requestId), hash: chatHash([body.name.trim(), createHash('sha256').update(bytes).digest('hex')]) };
}
