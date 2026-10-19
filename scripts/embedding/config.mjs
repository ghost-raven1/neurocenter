import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
export const modelLock = JSON.parse(readFileSync(new URL('./model.lock.json', import.meta.url), 'utf8'));

/** Порт и Compose-проект принадлежат этому checkout; каталог моделей всегда внутри него. */
export function configuration(env = process.env, root = repositoryRoot, profile = 'embedding') {
    if (!['embedding', 'vision'].includes(profile)) throw new Error('Неизвестный профиль модели.');
    const lock = profile === 'embedding' ? modelLock : JSON.parse(readFileSync(new URL('../vision/model.lock.json', import.meta.url), 'utf8'));
    const [name, tag] = lock.model.split(':');
    const port = Number(env.EMBEDDING_PORT || 11435);
    if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 11434) {
        throw new Error('EMBEDDING_PORT: укажите порт 1024–65535, отличный от 11434 глобального Ollama.');
    }
    const data = path.join(root, 'data/embedding');
    return {root, port, data, capability: profile, upCommand: `npm run ${profile}:up`, baseUrl: `http://127.0.0.1:${port}`,
        project: 'neurocenter-embedding-' + createHash('sha256').update(root).digest('hex').slice(0, 12),
        manifest: path.join(data, 'models/manifests/registry.ollama.ai/library', name, tag),
        receipt: path.join(data, profile === 'embedding' ? 'readiness.json' : 'vision-readiness.json'), lock};
}

/** Сравнивает реальный registry digest, а не имя изменяемого тега. */
export function lockedModel(tags, lock = modelLock) {
    return Array.isArray(tags?.models) && tags.models.some(model => model.name === lock.model && model.digest === lock.manifestSha256);
}
