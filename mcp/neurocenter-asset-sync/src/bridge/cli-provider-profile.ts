import { execFile, type ChildProcess } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { readInstalledRuntimeEnvironment } from './cli-profile.js';
import { authorizeManagedProvider } from '../features/opencode-providers/authorization.js';
const directory = fileURLToPath(new URL('../../', import.meta.url));
const denied = (cause?: unknown) =>
    new Error(
        'Не удалось проверить доступ к провайдеру. Проверьте сохранённый профиль моста и откройте настройку заново.',
        { cause },
    );
const program = `try{const{authorizeManagedProvider}=await import(process.argv[1]);process.stdout.write(JSON.stringify(await authorizeManagedProvider(JSON.parse(process.argv[2]))));}catch{process.stdout.write(JSON.stringify({ok:false}));process.exitCode=1;}`;
/** OpenCode plugins inherit caller HOME; private bridge identity and CA/proxy belong to the admitted saved profile. */
export async function authorizeInstalledProviderProfile(input: unknown): Promise<{ ok: true; allowed: true }> {
    const environment = await readInstalledRuntimeEnvironment(false);
    if (!environment) return authorizeManagedProvider(input);
    const abort = new AbortController(),
        stop = () => abort.abort();
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    let child: ChildProcess | undefined, hard: NodeJS.Timeout | undefined, grace: NodeJS.Timeout | undefined;
    const force = () => {
        grace = setTimeout(() => child?.kill('SIGKILL'), 1000);
        grace.unref();
    };
    abort.signal.addEventListener('abort', force, { once: true });
    try {
        const pending = new Promise<{ error: Error | null; stdout: string }>((resolve) => {
            child = execFile(
                process.execPath,
                [
                    '--input-type=module',
                    '--eval',
                    program,
                    pathToFileURL(path.join(directory, 'dist/features/opencode-providers/authorization.js')).href,
                    JSON.stringify(input),
                ],
                {
                    env: environment,
                    encoding: 'utf8',
                    timeout: 25000,
                    maxBuffer: 8192,
                    windowsHide: true,
                    signal: abort.signal,
                },
                (error, stdout) => resolve({ error, stdout }),
            );
        });
        if (child) {
            hard = setTimeout(() => child?.kill('SIGKILL'), 26000);
            hard.unref();
            await new Promise<void>((resolve) => child!.once('close', () => resolve()));
        }
        const output = await pending;
        let value: unknown;
        try {
            value = JSON.parse(output.stdout);
        } catch {
            throw denied(output.error);
        }
        if (
            output.error ||
            !value ||
            typeof value !== 'object' ||
            Array.isArray(value) ||
            Object.keys(value).sort().join(',') !== 'allowed,ok' ||
            (value as { ok?: unknown }).ok !== true ||
            (value as { allowed?: unknown }).allowed !== true
        )
            throw denied(output.error);
        return { ok: true, allowed: true };
    } finally {
        clearTimeout(hard);
        clearTimeout(grace);
        abort.signal.removeEventListener('abort', force);
        process.off('SIGTERM', stop);
        process.off('SIGINT', stop);
    }
}
