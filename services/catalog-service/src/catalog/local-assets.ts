import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

export interface ILocalAssetProject {
    project: string;
    path: string;
    skills: string[];
    mcpServers: string[];
    /** Конфигурации MCP-серверов из opencode.json (имя → объект mcp.<name>). */
    mcpConfigs: Record<string, Record<string, unknown>>;
    plugins: string[];
}

export interface ILocalAssetsScan {
    root: string;
    query: string | null;
    projects: ILocalAssetProject[];
    scannedCount: number;
    totalProjects: number;
}

/** Файл бандла для локальной установки. */
export interface ILocalAssetFile {
    path: string;
    content: string;
}

export interface ILocalAssetInstall {
    kind: 'mcp' | 'plugin' | 'skill';
    name: string;
    projectName: string;
    content?: string;
    config?: Record<string, unknown>;
    /** Дерево файлов бандла (multi-file: скиллы с references/scripts, плагины, MCP-бандлы). */
    files?: ILocalAssetFile[];
    /** Источник (origin) сущности каталога, напр. «local:<project>» — для резолва контента плагина. */
    origin?: string;
    action?: 'install' | 'uninstall';
    dryRun?: boolean;
}

export interface ILocalAssetInstallResult {
    kind: string;
    name: string;
    action: string;
    targetPath: string;
    affected: string;
    dryRun: boolean;
}

function isDir(p: string): Promise<boolean> {
    return fs.stat(p).then((s) => s.isDirectory()).catch(() => false);
}

function isFile(p: string): Promise<boolean> {
    return fs.stat(p).then((s) => s.isFile()).catch(() => false);
}

/** Допустимое имя проекта/файла: латиница, цифры, «.», «_», «-» (без «/» и «..» на старте). */
const SAFE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Проверяет, что строка — безопасное имя каталога/файла (защита от path traversal).
 *
 * @param value - проверяемая строка.
 * @param what - человекочитаемое описание (для сообщения об ошибке).
 * @throws {Error} при недопустимом имени.
 */
function assertSafeName(value: unknown, what: string): void {
    if (typeof value !== 'string' || !SAFE_NAME_RE.test(value)) {
        throw new Error(`Недопустимое имя: ${what}`);
    }
}

/**
 * Разрешает корень скана: относительно home, без абсолютных путей и «..»
 * (защита от выхода за пределы рабочих каталогов пользователя).
 *
 * @param root - базовый каталог (относительно home, опционально).
 * @returns {string} абсолютный путь корня скана.
 * @throws {Error} при недопустимом корне.
 */
function resolveScanRoot(root?: string): string {
    if (root === undefined || root.trim().length === 0) {
        return projectsRoot();
    }
    const cleaned = root.trim().replace(/^~\/?/, '');

    if (path.isAbsolute(cleaned) || cleaned.includes('..')) {
        throw new Error('Недопустимый корень скана (запрещены абсолютные пути и «..»)');
    }

    return path.resolve(os.homedir(), cleaned);
}

/** Единый корень проектов для скана, установки и проверки путей на хосте и в контейнере. */
function projectsRoot(): string {
    return path.resolve(process.env.PROJECTS_ROOT || path.join(os.homedir(), 'projects'));
}

/**
 * Разрешает `fs_root_path` проекта: абсолютный путь, находящийся под `~/projects`
 * (защита от наведения restore/sync на чужие каталоги).
 *
 * @param value - `fsRootPath` из запроса.
 * @returns {string} нормализованный абсолютный путь.
 * @throws {Error} если путь не абсолютный или выходит за пределы `~/projects`.
 */
export function resolveFsRootPath(value: string): string {
    const p = path.resolve(value);
    const root = projectsRoot();

    if (p !== root && !p.startsWith(`${root}${path.sep}`)) {
        throw new Error('fsRootPath должен находиться внутри каталога проектов');
    }

    return p;
}

/**
 * Скан локальных проектов под базовым каталогом (деф. ~/projects): что где установлено
 * (скиллы .opencode/skills, MCP opencode.json → mcp, плагины .opencode/plugins).
 *
 * @param root - базовый каталог (относительно home, опционально).
 * @param query - фильтр по названию проекта (подстрока, без учёта регистра).
 * @param maxProjects - максимум проектов.
 * @returns {Promise<ILocalAssetsScan>}
 */
export async function scanLocalAssets(root?: string, query?: string, maxProjects = 100): Promise<ILocalAssetsScan> {
    const base = resolveScanRoot(root);
    let names: string[] = [];
    try {
        names = await fs.readdir(base);
    } catch {
        names = [];
    }

    const projects: ILocalAssetProject[] = [];
    for (const name of names) {
        if (projects.length >= maxProjects) {
            break;
        }
        const p = path.join(base, name);
        if (!(await isDir(p))) {
            continue;
        }

        const skills: string[] = [];
        const skillDir = path.join(p, '.opencode', 'skills');
        try {
            const es = await fs.readdir(skillDir, { withFileTypes: true });
            for (const e of es) {
                if (e.isDirectory() && (await isFile(path.join(skillDir, e.name, 'SKILL.md')))) {
                    skills.push(e.name);
                }
            }
        } catch {
            // нет каталога скиллов.
        }

        const mcpServers: string[] = [];
        const mcpConfigs: Record<string, Record<string, unknown>> = {};
        for (const c of [
            path.join(p, '.opencode', 'opencode.json'),
            path.join(p, 'opencode.json'),
            path.join(p, '.opencode', 'opencode.jsonc'),
        ]) {
            try {
                const j = (JSON.parse(await fs.readFile(c, 'utf8')) as { mcp?: Record<string, unknown> }) ?? {};
                if (j.mcp) {
                    for (const [ name, value ] of Object.entries(j.mcp)) {
                        mcpServers.push(name);
                        if (value && typeof value === 'object' && !Array.isArray(value)) {
                            mcpConfigs[name] = value as Record<string, unknown>;
                        }
                    }
                    break;
                }
            } catch {
                // нет конфига.
            }
        }

        const plugins: string[] = [];
        const pluginDir = path.join(p, '.opencode', 'plugins');
        try {
            const es = await fs.readdir(pluginDir);
            for (const e of es) {
                if (/\.(js|ts|mjs|zip)$/i.test(e)) {
                    plugins.push(e.replace(/\.(js|ts|mjs|zip)$/i, ''));
                }
            }
        } catch {
            // нет каталога плагинов.
        }

        projects.push({ project: name, path: p, skills, mcpServers, mcpConfigs, plugins });
    }

    const q = (query && query.trim()) ? query.trim().toLowerCase() : null;
    const filtered = q ? projects.filter((pr) => pr.project.toLowerCase().includes(q)) : projects;

    return { root: base, query: q, projects: filtered, scannedCount: projects.length, totalProjects: filtered.length };
}

function slugify(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'asset';
}

/**
 * Форматирует запись MCP-сервера в формат `opencode.json` (mcp.<name>):
 * «type: local/remote» обязателен; local — `enabled` + `command`-массив
 * [бинарь, …args] (стиль реальных проектов), remote — `url`. Чужие поля
 * (transport и т.п.) не копируются; `env` сохраняется.
 *
 * @param name - имя MCP-сервера.
 * @param config - конфиг из каталога (опционально).
 * @returns {Record<string, unknown>} запись для mcp.<name>.
 */
function buildMcpEntry(name: string, config?: Record<string, unknown>): Record<string, unknown> {
    if (config && typeof config.url === 'string' && config.url.length > 0) {
        return { type: 'remote', url: config.url };
    }

    const env: unknown = config && config.env && typeof config.env === 'object' ? config.env : undefined;
    const withEnv: (entry: Record<string, unknown>) => Record<string, unknown> = (entry) => (env !== undefined ? { ...entry, env } : entry);

    const command = config?.command;
    const args = Array.isArray(config?.args) ? (config?.args as string[]) : [];

    if (typeof command === 'string' && command.length > 0) {
        return withEnv({ type: 'local', enabled: true, command: [ command, ...args ] });
    }
    if (Array.isArray(command) && command.every((c) => typeof c === 'string')) {
        return withEnv({ type: 'local', enabled: true, command });
    }
    return withEnv({ type: 'local', enabled: true, command: [ 'npx', '-y', name ] });
}

/**
 * Ищет исходный файл плагина на диске (для установки без content):
 * сначала в проекте-источнике из origin («local:<project>»), затем во всех
 * каталогах проекта: ~/projects/&lt;проект&gt;/.opencode/plugins/&lt;name&gt;.js.
 *
 * @param name - имя плагина.
 * @param origin - origin сущности каталога (опционально).
 * @returns {Promise<string | null>} путь к найденному файлу.
 */
async function findPluginSource(name: string, origin?: string): Promise<string | null> {
    const fileName = `${name}.js`;
    const base = projectsRoot();

    const localProject = origin && origin.startsWith('local:') ? origin.slice('local:'.length).trim() : '';
    const candidates: string[] = [];
    if (localProject.length > 0 && SAFE_NAME_RE.test(localProject)) {
        candidates.push(path.join(base, localProject, '.opencode', 'plugins', fileName));
    }

    if (candidates.length === 0) {
        let entries: string[] = [];
        try {
            entries = await fs.readdir(base);
        } catch {
            entries = [];
        }
        for (const entry of entries) {
            candidates.push(path.join(base, entry, '.opencode', 'plugins', fileName));
        }
    }

    for (const candidate of candidates) {
        if (await isFile(candidate)) {
            return candidate;
        }
    }

    return null;
}

/**
 * Безопасный join: относительный путь файла внутри базового каталога
 * (запрещены абсолютные пути, «..»/«.»/пустые сегменты — защита от path traversal).
 *
 * @param {string} base - базовый каталог (абсолютный).
 * @param {string} rel - относительный путь файла.
 * @returns {string} абсолютный путь.
 * @throws {Error} при недопустимом пути.
 */
function safeJoin(base: string, rel: string): string {
    if (typeof rel !== 'string' || rel.trim().length === 0) {
        throw new Error(`Недопустимый путь файла: ${String(rel)}`);
    }
    const norm = rel.replace(/\\/g, '/').trim();
    if (path.isAbsolute(norm) || norm.split('/').some(seg => seg === '' || seg === '..' || seg === '.')) {
        throw new Error(`Недопустимый путь файла: ${rel}`);
    }
    const target = path.join(base, norm);
    if (!target.startsWith(base + path.sep)) {
        throw new Error(`Недопустимый путь файла: ${rel}`);
    }
    return target;
}

/**
 * Записывает дерево файлов бандла (mkdir -p + текстовые файлы).
 *
 * @param {string} base - базовый каталог.
 * @param {ILocalAssetFile[]} files - файлы бандла.
 * @returns {Promise<string[]>} записанные абсолютные пути.
 */
async function writeFilesTree(base: string, files: ILocalAssetFile[]): Promise<string[]> {
    const written: string[] = [];
    for (const f of files) {
        const abs = safeJoin(base, f.path);
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, f.content ?? '', 'utf8');
        written.push(abs);
    }
    return written;
}

/**
 * Вычисляет entry-файл MCP-бандла (частые имена, иначе первый .js).
 *
 * @param {ILocalAssetFile[]} files - файлы бандла.
 * @returns {string} относительный путь entry.
 */
function pickBundleEntry(files: ILocalAssetFile[]): string {
    const names = files.map(f => f.path.replace(/\\/g, '/'));
    for (const candidate of ['dist/index.js', 'index.js', 'main.js', 'src/index.js']) {
        if (names.includes(candidate)) {
            return candidate;
        }
    }
    const js = names.find(p => p.endsWith('.js'));
    return js ?? (names[0] ?? 'index.js');
}

/**
 * Формирует запись `mcp.<name>` для opencode.json: local-бандл (command = node <abs entry>),
 * либо remote (если задан config.url).
 *
 * @param {string} dir - каталог развёрнутого бандла.
 * @param {ILocalAssetFile[]} files - файлы.
 * @param {Record<string, unknown> | undefined} config - исходный конфиг (env / url).
 * @returns {Record<string, unknown>} запись `mcp.<name>`.
 */
function buildBundleMcpEntry(dir: string, files: ILocalAssetFile[], config?: Record<string, unknown>): Record<string, unknown> {
    if (config && typeof config.url === 'string' && config.url.length > 0) {
        return { type: 'remote', url: config.url };
    }
    const env = config && config.env && typeof config.env === 'object' ? config.env : undefined;
    const entryAbs = path.join(dir, pickBundleEntry(files));
    const base: Record<string, unknown> = { type: 'local', enabled: true, command: ['node', entryAbs] };
    return env !== undefined ? Object.assign(base, { env }) : base;
}

/**
 * Применяет запись `mcp.<name>` в opencode.json (null — удаляет).
 *
 * @param {string} cfg - путь к opencode.json.
 * @param {string} name - имя MCP-сервера.
 * @param {Record<string, unknown> | null} entry - запись (null — удалить).
 * @returns {Promise<string>} путь к файлу.
 */
async function applyMcpConfig(cfg: string, name: string, entry: Record<string, unknown> | null): Promise<string> {
    let rootObj: Record<string, unknown> = {};
    try {
        rootObj = (JSON.parse(await fs.readFile(cfg, 'utf8')) as Record<string, unknown>) ?? {};
    } catch {
        rootObj = {};
    }
    const mcp = typeof rootObj.mcp === 'object' && rootObj.mcp !== null ? (rootObj.mcp as Record<string, unknown>) : {};
    if (entry === null) {
        delete mcp[name];
    } else {
        mcp[name] = entry;
    }
    if (Object.keys(mcp).length > 0) {
        rootObj.mcp = mcp;
    } else {
        delete rootObj.mcp;
    }
    await fs.mkdir(path.dirname(cfg), { recursive: true });
    await fs.writeFile(cfg, JSON.stringify(rootObj, null, 2), 'utf8');
    return cfg;
}

/**
 * Устанавливает/удаляет актив в локальном проекте (~/projects/<projectName>):
 * skill → .opencode/skills/<slug>/SKILL.md, plugin → .opencode/plugins/<name>.js
 * (контент — из запроса или с диска), mcp → .opencode/opencode.json (mcp.<name>,
 * формат opencode: type/enabled/command-массив).
 *
 * @param input - параметры установки/удаления.
 * @returns {Promise<ILocalAssetInstallResult>}
 */
export async function installLocalAsset(input: ILocalAssetInstall): Promise<ILocalAssetInstallResult> {
    assertSafeName(input.projectName, 'имя проекта');

    if (input.kind === 'plugin') {
        assertSafeName(input.name, 'имя плагина');
    }

    const target = path.join(projectsRoot(), input.projectName);
    const dryRun = input.dryRun === true;
    const action = input.action ?? 'install';
    const remove = action === 'uninstall';
    const files = input.files ?? [];
    const tree = files.length > 0;

    if (input.kind === 'skill') {
        const slug = slugify(input.name);
        const dir = path.join(target, '.opencode', 'skills', slug);
        if (tree) {
            if (!dryRun) {
                if (remove) {
                    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
                } else {
                    await writeFilesTree(dir, files);
                }
            }
            return { kind: 'skill', name: input.name, action, targetPath: target, affected: dir, dryRun };
        }
        const file = path.join(dir, 'SKILL.md');
        if (!dryRun) {
            if (remove) {
                await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
            } else {
                await fs.mkdir(dir, { recursive: true });
                if (input.content) {
                    await fs.writeFile(file, input.content, 'utf8');
                }
            }
        }
        return { kind: 'skill', name: input.name, action, targetPath: target, affected: file, dryRun };
    }

    if (input.kind === 'plugin') {
        if (tree) {
            const dir = path.join(target, '.opencode', 'plugins', input.name);
            if (!dryRun) {
                if (remove) {
                    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
                } else {
                    await writeFilesTree(dir, files);
                }
            }
            return { kind: 'plugin', name: input.name, action, targetPath: target, affected: dir, dryRun };
        }
        const file = path.join(target, '.opencode', 'plugins', `${input.name}.js`);

        // Контент: явно в теле запроса ИЛИ с диска (проект-источник из origin / скан ~/projects).
        let content = input.content;
        if (!remove && (content === undefined || content.length === 0)) {
            const source = await findPluginSource(input.name, input.origin);
            if (!source) {
                throw new Error(`Исходный файл плагина «${input.name}.js» не найден на диске (~/projects/*/.opencode/plugins/)`);
            }
            content = await fs.readFile(source, 'utf8');
        }

        if (!dryRun) {
            if (remove) {
                await fs.rm(file, { force: true }).catch(() => undefined);
            } else {
                await fs.mkdir(path.dirname(file), { recursive: true });
                if (content) {
                    await fs.writeFile(file, content, 'utf8');
                }
            }
        }
        return { kind: 'plugin', name: input.name, action, targetPath: target, affected: file, dryRun };
    }

    const cfg = path.join(target, '.opencode', 'opencode.json');

    // Multi-file MCP-бандл: разворачиваем дерево + command = node <entry>.
    if (tree) {
        const dir = path.join(target, '.opencode', 'mcp-bundles', input.name);
        if (!dryRun) {
            if (remove) {
                await applyMcpConfig(cfg, input.name, null);
                await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
            } else {
                await writeFilesTree(dir, files);
                await applyMcpConfig(cfg, input.name, buildBundleMcpEntry(dir, files, input.config));
            }
        }
        return { kind: 'mcp', name: input.name, action, targetPath: target, affected: cfg, dryRun };
    }

    // Legacy: одна конфигурация (command/npx/remote), без файлов.
    if (!dryRun) {
        await applyMcpConfig(cfg, input.name, remove ? null : buildMcpEntry(input.name, input.config));
    }
    return { kind: 'mcp', name: input.name, action, targetPath: target, affected: cfg, dryRun };
}
