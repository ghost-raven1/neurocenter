import path from 'node:path';
import { safeTarget } from '../bridge/workspace-paths.js';
import { locateStore } from './store.js';

/** Передача RAG читает и меняет только неизменный индекс внутри выбранного проекта. */
export function ragStoreBoundary(project: string | undefined, cwd: string, storePath: string): () => Promise<void> {
    const root = path.resolve(cwd, project ?? '.');
    const relative = path.relative(root, storePath).split(path.sep).join('/');
    if (!relative || relative.startsWith('../') || path.isAbsolute(relative)) {
        throw new Error('LanceDB должна находиться внутри подтверждённой папки проекта.');
    }
    return async () => {
        const current = await locateStore(project, cwd);
        if (current.storePath !== storePath || await safeTarget(root, relative) !== storePath) {
            throw new Error('Путь локального индекса изменился. Передача остановлена до следующей записи или удаления.');
        }
    };
}
