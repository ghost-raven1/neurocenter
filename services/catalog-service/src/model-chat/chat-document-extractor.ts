import {BadRequestException, ServiceUnavailableException, UnsupportedMediaTypeException} from '@nestjs/common';
import {Worker} from 'node:worker_threads';
import path from 'node:path';

export const CHAT_DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;
export const CHAT_DOCUMENT_MAX_TEXT_BYTES = 100 * 1024;
export const CHAT_DOCUMENT_TEXT_EXTENSIONS = new Set('txt md markdown csv tsv json jsonl yaml yml xml html css scss less js jsx mjs cjs ts tsx py java kt go rs c h cpp hpp cs rb php swift sh bash zsh sql toml ini log r lua vue svelte graphql gql properties conf cfg'.split(' '));
const specialNames = new Set(['dockerfile', 'makefile', '.gitignore', '.editorconfig']);
let activeWorkers = 0;
export interface IChatDocument {mediaType: string; text: string; pages?: number; warning?: string}

/** Extraction runs in a bounded worker; cancellation terminates parsing, including malformed documents. */
export async function extractChatDocument(name: string, bytes: Buffer, signal?: AbortSignal): Promise<IChatDocument> {
    if (typeof name !== 'string' || !name.trim() || name.length > 255 || /[\\/\x00-\x1f\x7f]/.test(name)) throw new BadRequestException('Некорректное имя файла.');
    if (!Buffer.isBuffer(bytes) || !bytes.length) throw new BadRequestException('Файл пуст.');
    if (bytes.length > CHAT_DOCUMENT_MAX_BYTES) throw new BadRequestException('Максимальный размер файла — 10 МиБ.');
    const extension = path.extname(name).slice(1).toLowerCase();
    const kind = extension === 'pdf' ? 'pdf' : extension === 'docx' ? 'docx' : CHAT_DOCUMENT_TEXT_EXTENSIONS.has(extension) || specialNames.has(name.toLowerCase()) ? 'text' : null;
    if (!kind) throw new UnsupportedMediaTypeException('Поддерживаются PDF, DOCX и текстовые файлы. Изображения и OCR сканов пока недоступны: нужна vision-модель.');
    signal?.throwIfAborted();
    if (activeWorkers >= 2) throw new ServiceUnavailableException('Сервер уже обрабатывает документы. Повторите загрузку через несколько секунд.');
    return new Promise<IChatDocument>((resolve, reject) => {
        activeWorkers++;
        let worker: Worker;
        try {
        worker = new Worker(require.resolve('../../../shared/chat-document-worker.cjs'), {
            workerData: {kind, bytes, maxTextBytes: CHAT_DOCUMENT_MAX_TEXT_BYTES,
                pdfModule: require.resolve('pdfjs-dist/legacy/build/pdf.mjs'), mammothModule: require.resolve('mammoth'), yauzlModule: require.resolve('yauzl')},
            resourceLimits: {maxOldGenerationSizeMb: 128, stackSizeMb: 4},
        });
        } catch {activeWorkers--; reject(new ServiceUnavailableException('Обработчик документов недоступен. Повторите загрузку.')); return;}
        let settled = false;
        const finish = (error?: unknown, value?: IChatDocument): void => {
            if (settled) return;
            settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
            // A cancelled worker keeps its admission slot until V8 and its external buffers have exited.
            const complete = (): void => {activeWorkers--; if (error) reject(error); else resolve(value!);};
            void worker.terminate().then(complete, complete);
        };
        const abort = (): void => finish(signal?.reason ?? new Error('Обработка файла отменена.'));
        const timer = setTimeout(() => finish(new BadRequestException('Обработка файла заняла слишком долго. Уменьшите документ или сохраните его как текст.')), 15000);
        worker.once('message', (message: {ok: boolean; value?: IChatDocument; error?: string}) => {
            if (message.ok && message.value && typeof message.value.text === 'string' && Buffer.byteLength(message.value.text) <= CHAT_DOCUMENT_MAX_TEXT_BYTES) finish(undefined, message.value);
            else finish(new BadRequestException(message.error || 'Не удалось извлечь текст файла.'));
        });
        worker.once('error', () => finish(new BadRequestException('Не удалось обработать документ в пределах доступной памяти.')));
        worker.once('exit', () => finish(new BadRequestException('Обработка документа была прервана.')));
        signal?.addEventListener('abort', abort, {once: true});
        if (signal?.aborted) abort();
    });
}
