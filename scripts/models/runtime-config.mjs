import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
/** Порт и Compose-проект принадлежат этому checkout; каталог моделей всегда внутри него. */
export function configuration(env = process.env, root = repositoryRoot) {
    const port = Number(env.EMBEDDING_PORT || 11435);
    if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 11434) {
        throw new Error('EMBEDDING_PORT: укажите порт 1024–65535, отличный от 11434 глобального Ollama.');
    }
    const data = path.resolve(root, env.MODEL_STORAGE_PATH || env.EMBEDDING_DATA_DIR || 'data/embedding');
    if (data === path.resolve(root) || !data.startsWith(path.resolve(root) + path.sep)) {
        throw new Error('Каталог моделей должен находиться внутри проекта. Укажите MODEL_STORAGE_PATH внутри Нейроцентра.');
    }
    return {root, port, data, baseUrl: `http://127.0.0.1:${port}`,
        project: 'neurocenter-embedding-' + createHash('sha256').update(root).digest('hex').slice(0, 12)};
}
