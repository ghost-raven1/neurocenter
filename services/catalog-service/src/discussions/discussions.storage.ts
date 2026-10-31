import { BadRequestException, ConflictException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { Readable } from 'node:stream';
import {
    ChatObjectStorage,
    chatObjectDigest,
    chatS3Configuration,
    type ChatObjectReference,
} from '../model-chat/chat-object-storage';
import type { AttachmentRow, DiscussionAttachment } from './discussions.types';

export const DISCUSSION_FILE_LIMIT = 10 * 1024 * 1024;
const names: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.csv': 'text/csv',
    '.json': 'application/json',
    '.log': 'text/plain',
    '.zip': 'application/zip',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};
export function discussionFileName(value: unknown): { name: string; mediaType: string } {
    let name: string;
    try {
        name = decodeURIComponent(String(value ?? ''));
    } catch {
        throw new BadRequestException('Не удалось прочитать имя файла.');
    }
    if (!name || name.length > 240 || /[\x00-\x1f\x7f/\\]/.test(name) || name === '.' || name === '..')
        throw new BadRequestException('Укажите безопасное имя файла до 240 знаков.');
    const extension = /\.[^.]+$/.exec(name)?.[0].toLowerCase() || '',
        mediaType = names[extension];
    if (!mediaType) throw new BadRequestException('Поддерживаются изображения, PDF, текст, JSON, ZIP и DOCX.');
    return { name, mediaType };
}
export function discussionFileContent(bytes: Buffer, mediaType: string): void {
    const starts = (signature: string): boolean =>
        bytes.subarray(0, Buffer.byteLength(signature, 'binary')).equals(Buffer.from(signature, 'binary'));
    const valid =
        mediaType === 'image/png'
            ? starts('\x89PNG\r\n\x1a\n')
            : mediaType === 'image/jpeg'
              ? starts('\xff\xd8\xff')
              : mediaType === 'image/gif'
                ? starts('GIF87a') || starts('GIF89a')
                : mediaType === 'image/webp'
                  ? starts('RIFF') && bytes.subarray(8, 12).toString() === 'WEBP'
                  : mediaType === 'application/pdf'
                    ? starts('%PDF-')
                    : mediaType.includes('zip') || mediaType.includes('wordprocessingml')
                      ? starts('PK\x03\x04') || starts('PK\x05\x06')
                      : (() => {
                            try {
                                const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
                                return !text.includes('\0');
                            } catch {
                                return false;
                            }
                        })();
    if (!valid) throw new BadRequestException('Содержимое не соответствует типу файла.');
}
export function discussionAttachmentView(row: AttachmentRow): DiscussionAttachment {
    return {
        id: row.id,
        name: row.name,
        mediaType: row.media_type,
        bytes: row.bytes,
        url: '/api/discussions/attachments/' + row.id + '/content',
    };
}

/** Reuses the private S3 transport only; discussion identity never borrows a chat ACL. */
@Injectable()
export class DiscussionsStorage {
    readonly objects: ChatObjectStorage | null;
    readonly unavailableReason?: string;
    private initialization?: Promise<void>;
    private receiving = 0;
    constructor() {
        try {
            const config = chatS3Configuration();
            this.objects = config ? new ChatObjectStorage(config) : null;
        } catch {
            this.objects = null;
        }
        if (!this.objects)
            this.unavailableReason =
                'Файлы временно недоступны. Администратору нужно подключить закрытое Ceph/S3-хранилище. Текстовый комментарий можно отправить.';
    }
    private ready(): Promise<void> {
        if (!this.objects) throw new ServiceUnavailableException(this.unavailableReason);
        return (this.initialization ??= this.objects.initialize().catch((error) => {
            this.initialization = undefined;
            throw error;
        }));
    }
    async consume(stream: Readable, declared: unknown, signal?: AbortSignal): Promise<Buffer> {
        if (!/^\d+$/.test(String(declared)) || Number(declared) < 1 || Number(declared) > DISCUSSION_FILE_LIMIT)
            throw new BadRequestException('Размер файла должен быть от 1 байта до 10 МиБ.');
        if (this.receiving >= 2) throw new ConflictException('Дождитесь завершения текущей загрузки файлов.');
        this.receiving++;
        const chunks: Buffer[] = [];
        let size = 0;
        const deadline = setTimeout(() => stream.destroy(new Error('upload-timeout')), 60000);
        deadline.unref();
        const abort = (): void => {
            stream.destroy(new Error('upload-cancelled'));
        };
        signal?.addEventListener('abort', abort, { once: true });
        try {
            if (signal?.aborted) abort();
            for await (const part of stream) {
                const bytes = Buffer.from(part);
                size += bytes.length;
                if (size > DISCUSSION_FILE_LIMIT || size > Number(declared))
                    throw new BadRequestException('Размер файла больше объявленного.');
                chunks.push(bytes);
            }
            if (size !== Number(declared))
                throw new BadRequestException('Файл передан не полностью. Повторите загрузку.');
            return Buffer.concat(chunks);
        } finally {
            clearTimeout(deadline);
            signal?.removeEventListener('abort', abort);
            this.receiving--;
        }
    }
    reference(row: AttachmentRow): ChatObjectReference {
        return {
            storage_id: row.storage_id,
            bucket: row.bucket,
            object_key: row.object_key,
            version_id: row.version_id,
            sha256: row.sha256,
            bytes: row.bytes,
        };
    }
    intent(
        id: string,
        owner: string,
        target: string,
        bytes: Buffer,
    ): Pick<AttachmentRow, 'storage_id' | 'bucket' | 'object_key' | 'sha256'> {
        if (!this.objects) throw new ServiceUnavailableException(this.unavailableReason);
        const hash = chatObjectDigest(target),
            targetUuid = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
        return {
            storage_id: this.objects.storageId,
            bucket: this.objects.config.personalBucket,
            object_key: `owners/${chatObjectDigest(owner)}/chats/${targetUuid}/${id}`,
            sha256: chatObjectDigest(bytes),
        };
    }
    async put(row: AttachmentRow, bytes: Buffer, signal?: AbortSignal): Promise<string | null> {
        await this.ready();
        const reference = this.reference(row);
        // Recover a previous uncertain PUT before sending bytes again to a versioned bucket.
        let existing: Awaited<ReturnType<NonNullable<typeof this.objects>['client']['statObject']>> | undefined;
        try {
            signal?.throwIfAborted();
            existing = await this.objects!.client.statObject(reference.bucket, reference.object_key);
        } catch (error) {
            const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
            if (!['NoSuchKey', 'NotFound', 'NoSuchObject'].includes(code)) {
                signal?.throwIfAborted();
                throw new ServiceUnavailableException(
                    'Не удалось проверить ранее загруженный файл. Повторите загрузку с тем же ключом.',
                );
            }
        }
        if (existing) {
            if (existing.size !== row.bytes) throw new ConflictException('Размер ранее загруженного файла изменился.');
            const version = existing.versionId && existing.versionId !== 'null' ? existing.versionId : null;
            await this.objects!.assertPrivate({ ...reference, version_id: version }, signal);
            await this.objects!.read({ ...reference, version_id: version }, signal);
            return version;
        }
        const version = await this.objects!.put(reference, bytes, signal);
        await this.objects!.assertPrivate({ ...reference, version_id: version }, signal);
        await this.objects!.read({ ...reference, version_id: version }, signal);
        return version;
    }
    async read(row: AttachmentRow, signal?: AbortSignal): Promise<Buffer> {
        await this.ready();
        await this.objects!.assertPrivate(this.reference(row), signal);
        return this.objects!.read(this.reference(row), signal);
    }
    async remove(row: AttachmentRow): Promise<void> {
        await this.ready();
        await this.objects!.remove(this.reference(row));
    }
}
