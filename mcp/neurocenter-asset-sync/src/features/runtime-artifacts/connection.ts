import path from 'node:path';
import type { Package } from '../../bridge/package.js';
import { stateDir } from '../../bridge/state.js';
import { selectedRuntimeArtifact } from './cache.js';

/** Канонический путь не зависит от папки проекта; байты проверяются перед установкой и запуском. */
export function runtimeArtifactConnection(pkg: Package): { root: string; entrypoint: string; command: string[] } | undefined {
    const artifact = selectedRuntimeArtifact(pkg);
    if (!artifact) { return undefined; }
    const root = path.join(stateDir(), 'runtime-artifacts', artifact.sha256);
    const entrypoint = path.join(root, artifact.entrypoint);
    return { root, entrypoint, command: artifact.executable ? [entrypoint, ...(pkg.config?.args ?? [])] : [process.execPath, entrypoint, ...(pkg.config?.args ?? [])] };
}
