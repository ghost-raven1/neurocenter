import {constants} from 'node:fs';
import {lstat, open} from 'node:fs/promises';

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const DEFAULT_VISION_QUESTION = 'Опиши, что изображено, и прочитай видимый текст.';
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Определяет поддерживаемый формат по сигнатуре; декодирование выполняет runtime модели. */
function imageMimeType(image) {
    if (image.length >= png.length && image.subarray(0, png.length).equals(png)) return 'image/png';
    if (image.length >= 3 && image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff) return 'image/jpeg';
    if (image.length >= 12 && image.toString('latin1', 0, 4) === 'RIFF' && image.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
    throw new Error('Поддерживаются PNG, JPEG и WebP. Формат определяется по содержимому файла.');
}

/** Пустой вопрос не заменяется неявно: значение по умолчанию применяется только без аргумента. */
export function visionQuestion(value = DEFAULT_VISION_QUESTION) {
    if (typeof value !== 'string' || !value.trim() || value.length > 4000 || value.includes('\0')) {
        throw new Error('Вопрос должен содержать от 1 до 4000 символов.');
    }
    return value.trim();
}

/** Читает явно выбранный локальный файл без перехода по ссылке и без неограниченного readFile. */
export async function readImageInput(filename) {
    if (typeof filename !== 'string' || !filename.trim() || /[\x00-\x1f\x7f]/.test(filename)
        || /^[a-z][a-z0-9+.-]*:\/\//i.test(filename)) {
        throw new Error('Укажите локальный путь к файлу изображения.');
    }
    let handle;
    try {
        const named = await lstat(filename);
        if (!named.isFile() || named.isSymbolicLink()) throw new Error('Изображение должно быть обычным файлом без символической ссылки.');
        handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const before = await handle.stat();
        if (!before.isFile() || before.ino !== named.ino || before.dev !== named.dev) throw new Error('Файл изображения изменился перед чтением.');
        if (!before.size || before.size > MAX_IMAGE_BYTES) throw new Error('Размер изображения должен быть больше нуля и не превышать 10 МиБ.');
        const buffer = Buffer.allocUnsafe(MAX_IMAGE_BYTES + 1);
        let size = 0;
        while (size < buffer.length) {
            const {bytesRead} = await handle.read(buffer, size, buffer.length - size, null);
            if (!bytesRead) break;
            size += bytesRead;
            if (size > MAX_IMAGE_BYTES) throw new Error('Размер изображения превышает 10 МиБ.');
        }
        const after = await handle.stat();
        const current = await lstat(filename);
        if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
            || current.isSymbolicLink() || current.ino !== before.ino || current.dev !== before.dev) {
            throw new Error('Файл изображения изменился во время чтения. Повторите запрос со стабильным файлом.');
        }
        const image = buffer.subarray(0, size);
        return {image, mimeType: imageMimeType(image)};
    } catch (error) {
        if (['ENOENT', 'ENOTDIR'].includes(error.code)) throw new Error('Файл изображения не найден. Укажите существующий локальный файл.');
        if (['EACCES', 'EPERM'].includes(error.code)) throw new Error('Нет доступа к файлу изображения. Проверьте права чтения.');
        if (error.code === 'ELOOP') throw new Error('Изображение должно быть обычным файлом без символической ссылки.');
        throw error;
    } finally {await handle?.close();}
}
