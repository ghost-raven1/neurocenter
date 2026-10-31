import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { parse, parseTree, type Node, type ParseError } from 'jsonc-parser';
import { connectBridge } from './connect.js';
import { hub, apiHub } from './state.js';
import { readBoundedSnapshot } from './read-bounded.js';

const directory = fileURLToPath(new URL('../../', import.meta.url));
const entryName = 'neurocenter-asset-sync';
type Json = Record<string, unknown>;
const object = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);
const invalid = () =>
    Error('Сохранённый профиль моста в OpenCode повреждён. Проверьте регистрацию или повторите установку.');
const properties = (node: Node | undefined, key: string) =>
    node?.children?.filter((property) => property.children?.[0]?.value === key) ?? [];
const duplicated = (node: Node | undefined) =>
    node?.type === 'object' &&
    new Set(node.children?.map((property) => property.children?.[0]?.value)).size !== node.children?.length;
async function selectedConfig() {
    const root = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'opencode');
    for (const name of ['opencode.jsonc', 'opencode.json']) {
        const logical = path.join(root, name);
        const found = await fs.lstat(logical).catch((error) => {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        });
        if (found) {
            const destination = await fs.realpath(logical);
            return { logical, destination, snapshot: await readBoundedSnapshot(destination, 8 * 1024 * 1024) };
        }
    }
}
const childProgram = `try{const{connectBridge}=await import(process.argv[1]);const result=await connectBridge(process.argv[2]==='1',process.argv[3]==='1');process.stdout.write(JSON.stringify({ok:true,result}));}catch(cause){const error=cause instanceof Error?cause.message.replace(/[\\x00-\\x1f\\x7f-\\x9f]/g,' ').slice(0,1200):'Проверьте соединение с сервером и повторите команду.';process.stdout.write(JSON.stringify({ok:false,error}));process.exitCode=1;}`;

/** Only the exact installed command selects runtime HOME/CA/proxy; management keeps caller HOME. */
export async function readInstalledRuntimeEnvironment(
    requireCurrentSite = true,
): Promise<NodeJS.ProcessEnv | undefined> {
    let selected: Awaited<ReturnType<typeof selectedConfig>>;
    try {
        selected = await selectedConfig();
    } catch (cause) {
        throw new Error('Не удалось прочитать сохранённый профиль OpenCode. Проверьте конфигурацию моста.', { cause });
    }
    if (!selected) return undefined;
    const text = selected.snapshot.bytes.toString('utf8'),
        errors: ParseError[] = [],
        value: unknown = parse(text, errors, { allowTrailingComma: true });
    if (
        !Buffer.from(text).equals(selected.snapshot.bytes) ||
        errors.length ||
        !object(value) ||
        (value.mcp !== undefined && !object(value.mcp))
    )
        throw invalid();
    const tree = parseTree(text),
        rootMcp = properties(tree, 'mcp'),
        ownProperties = properties(rootMcp[0]?.children?.[1], entryName),
        ownTree = ownProperties[0]?.children?.[1];
    if (
        rootMcp.length > 1 ||
        ownProperties.length > 1 ||
        duplicated(ownTree) ||
        duplicated(properties(ownTree, 'environment')[0]?.children?.[1])
    )
        throw invalid();
    const own = object(value.mcp) ? value.mcp[entryName] : undefined;
    if (own === undefined) return undefined;
    const expected = [
        path.join(directory, 'bin', process.platform === 'win32' ? 'node.exe' : 'node'),
        path.join(directory, 'dist/index.js'),
    ];
    if (
        !object(own) ||
        own.type !== 'local' ||
        JSON.stringify(own.command) !== JSON.stringify(expected) ||
        (own.enabled !== undefined && typeof own.enabled !== 'boolean')
    )
        throw invalid();
    const saved = own.environment ?? {};
    if (
        !object(saved) ||
        Object.entries(saved).some(
            ([key, value]) =>
                !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string' || value.includes('\0'),
        )
    )
        throw invalid();
    if (
        requireCurrentSite &&
        (saved.NEUROCENTER_URL !== hub() || (saved.NEUROCENTER_API_URL ?? saved.NEUROCENTER_URL) !== apiHub())
    )
        throw Error(
            'Сохранённый профиль моста относится к другой площадке или API. Используйте установщик нужной площадки.',
        );
    if (!requireCurrentSite)
        for (const address of [saved.NEUROCENTER_URL, saved.NEUROCENTER_API_URL ?? saved.NEUROCENTER_URL]) {
            try {
                const url = new URL(String(address));
                if (
                    !['http:', 'https:'].includes(url.protocol) ||
                    url.origin !== address ||
                    url.username ||
                    url.password
                )
                    throw invalid();
            } catch {
                throw invalid();
            }
        }
    if (['HOME', 'USERPROFILE', 'NEUROCENTER_BRIDGE_HOME'].some((key) => Object.hasOwn(saved, key) && !saved[key]))
        throw invalid();
    const environment = { ...process.env, ...saved } as NodeJS.ProcessEnv;
    // Detect cooperating edits before starting the admitted runtime, without claiming an atomic filesystem sandbox.
    let current: Awaited<ReturnType<typeof selectedConfig>>;
    try {
        current = await selectedConfig();
    } catch (cause) {
        throw new Error('Профиль OpenCode изменился. Повторите команду.', { cause });
    }
    if (
        !current ||
        current.logical !== selected.logical ||
        current.destination !== selected.destination ||
        current.snapshot.fingerprint !== selected.snapshot.fingerprint ||
        !current.snapshot.bytes.equals(selected.snapshot.bytes)
    )
        throw Error('Профиль OpenCode изменился. Повторите команду.');
    return environment;
}

/** Explicit caller origins retain the same-site admission used by the public short command. */
export async function connectInstalledProfile(
    openBrowser = false,
    reconnect = false,
): Promise<Awaited<ReturnType<typeof connectBridge>>> {
    const environment = await readInstalledRuntimeEnvironment();
    if (!environment) return connectBridge(openBrowser, reconnect);
    const output = await new Promise<{ error: Error | null; stdout: string }>((resolve) =>
        execFile(
            process.execPath,
            [
                '--input-type=module',
                '--eval',
                childProgram,
                pathToFileURL(path.join(directory, 'dist/bridge/connect.js')).href,
                openBrowser ? '1' : '0',
                reconnect ? '1' : '0',
            ],
            { env: environment, encoding: 'utf8', timeout: 90000, maxBuffer: 65536, windowsHide: true },
            (error, stdout) => resolve({ error, stdout }),
        ),
    );
    const failure = () =>
        new Error('Не удалось запустить сохранённое окружение моста. Проверьте его настройки и повторите команду.', {
            cause: output.error,
        });
    let result: unknown;
    try {
        result = JSON.parse(output.stdout);
    } catch {
        throw failure();
    }
    if (!object(result)) throw failure();
    if (result.ok === false && typeof result.error === 'string' && result.error.length <= 1200)
        throw new Error(result.error, { cause: output.error });
    if (output.error || result.ok !== true || !object(result.result)) throw failure();
    return result.result as Awaited<ReturnType<typeof connectBridge>>;
}
