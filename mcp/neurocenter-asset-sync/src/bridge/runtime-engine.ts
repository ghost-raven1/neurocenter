import path from 'node:path';
import { readBoundedUtf8 } from './read-bounded.js';

/** Используется только runtime собственного автономного пакета, без поиска личного OpenCode в PATH. */
export async function runtimeProbeEngine(): Promise<{path:string;version:'1.14.48';sha256:string}> {
    const root = path.dirname(path.dirname(process.execPath));
    try {
        const metadata = JSON.parse(await readBoundedUtf8(path.join(root,'runtime.json'),64 * 1024)) as {
            probeEngine?: {file?:string;version?:string;sha256?:string};
        };
        const engine = metadata.probeEngine;
        const expected = process.platform === 'win32' ? 'bin/opencode-probe.exe' : 'bin/opencode-probe';
        if (engine?.file !== expected || engine.version !== '1.14.48' || !/^[a-f0-9]{64}$/.test(engine.sha256 ?? '')) { throw new Error(); }
        return {path:path.join(root,expected),version:'1.14.48',sha256:engine.sha256!};
    } catch {
        // Пустой путь даёт фиксированный unsupported; глобальная установка не подменяет закреплённый движок.
        return {path:'',version:'1.14.48',sha256:''};
    }
}
