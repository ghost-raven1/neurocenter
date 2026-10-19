#!/usr/bin/env node
import path from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { installBridgeGlobal } from './lib/install.js';
import {connectBridge,startWorker,watchPair} from './bridge/connect.js';
import {runWorker} from './bridge/worker.js';
import {readState,type Credentials} from './bridge/state.js';
import {workspaceReport,setRoot} from './bridge/workspace.js';
import { BRIDGE_VERSION } from './bridge/protocol.js';
import { prepareWorkerUpgrade, finishWorkerUpgrade } from './bridge/worker-upgrade.js';
import {z} from 'zod';
import { ok, fail, errMsg, type TToolResult } from './lib/stdio.js';
import {
    detectProjectTool,
    detectProjectInputSchema,
    type TDetectProjectInput,
} from './tools/detect-project.js';
import {
    ragDbDiff,
    ragDbDiffInputSchema,
    type TRagDbDiffInput,
} from './tools/rag-db-diff.js';
import {
    ragDbInspect,
    ragDbInspectInputSchema,
    type TRagDbInspectInput,
} from './tools/rag-db-inspect.js';
import {
    resolveProjectKey,
    resolveProjectKeyInputSchema,
    type TResolveProjectKeyInput,
} from './tools/resolve-project-key.js';
import {
    restoreRagDb,
    restoreRagDbInputSchema,
    type TRestoreRagDbInput,
} from './tools/restore-rag-db.js';
import {
    scanPlugins,
    scanPluginsInputSchema,
    type TScanPluginsInput,
} from './tools/scan-plugins.js';
import {
    scanSkills,
    scanSkillsInputSchema,
    type TScanSkillsInput,
} from './tools/scan-skills.js';
import {
    scanWorkspaces,
    scanWorkspacesInputSchema,
    type TScanWorkspacesInput,
} from './tools/scan-workspaces.js';
import {
    syncRagDb,
    syncRagDbInputSchema,
    type TSyncRagDbInput,
} from './tools/sync-rag-db.js';
import {
    syncSkills,
    syncSkillsInputSchema,
    type TSyncSkillsInput,
} from './tools/sync-skills.js';
import {
    activateBundleVersion,
    bundleActivateInputSchema,
    bundleFileInputSchema,
    bundleVersionsInputSchema,
    listBundleVersions,
    readBundleFile,
    type TBundleActivateInput,
    type TBundleFileInput,
    type TBundleVersionsInput,
} from './tools/bundle.js';

const server = new McpServer({ name: 'neurocenter-asset-sync', version: BRIDGE_VERSION });
const cwd = process.cwd();
if (['--prepare-upgrade', '--finish-upgrade'].includes(process.argv[2] || '')) {
    try {
        if (process.argv[2] === '--prepare-upgrade') { await prepareWorkerUpgrade(process.argv[3] || ''); }
        else { await finishWorkerUpgrade(); }
        process.stdout.write(JSON.stringify({ ok: true }) + '\n');
    } catch {
        process.stdout.write(JSON.stringify({ ok: false, error: 'Не удалось безопасно остановить установленный мост. Дождитесь завершения заданий, проверьте подключение и повторите установку.' }) + '\n');
        process.exit(1);
    }
    process.exit(0);
}
if(process.argv[2]==='--worker'){await runWorker();await new Promise(()=>undefined);}
if(process.argv[2]==='--pair-watch'){await watchPair();process.exit(0);}
if(['--connect','--connect-open','--reconnect-open'].includes(process.argv[2]||'')){process.stdout.write(JSON.stringify(await connectBridge(process.argv[2]!=='--connect',process.argv[2]==='--reconnect-open'),null,2)+'\n');process.exit(0);}
if(process.argv[2]==='--projects-root'){await setRoot(process.argv[3]||'');process.stdout.write(JSON.stringify(await workspaceReport())+'\n');process.exit(0);}

/**
 * Oneshot-CLI: `node dist/index.js --run restore_rag_db '{"projectKey":"prj-…","project":"…"}'`.
 * Выполняет tool без MCP stdio-handshake — нужен bff-эндпоинту rag-sync,
 * который спавнит мост как обычный child-процесс и читает JSON из stdout.
 */
if (process.argv[2] === '--init') {
    try {
        const res = await installBridgeGlobal();
        process.stdout.write(
            JSON.stringify({ ok: true, ...res, note: 'мост зарегистрирован в глобальном конфиге opencode' }),
        );
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        process.stdout.write(JSON.stringify({ ok: false, error: msg }));
        process.exit(1);
    }
    process.exit(0);
}
if (process.argv[2] === '--run') {
    const tool = process.argv[3];
    let args: unknown = {};
    if (process.argv[4]) {
        try {
            args = JSON.parse(process.argv[4]);
        } catch {
            process.stdout.write(JSON.stringify({ ok: false, error: 'invalid-json-args' }));
            process.exit(1);
        }
    }
    try {
        if (tool === 'restore_rag_db') {
            const out = await restoreRagDb(restoreRagDbInputSchema.parse(args), cwd);
            process.stdout.write(out);
            process.exit(0);
        }
        if (tool === 'sync_rag_db') {
            const out = await syncRagDb(syncRagDbInputSchema.parse(args), cwd);
            process.stdout.write(out);
            process.exit(0);
        }
        process.stdout.write(JSON.stringify({ ok: false, error: `unknown-tool: ${tool}` }));
        process.exit(1);
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        process.stdout.write(JSON.stringify({ ok: false, error: msg }));
        process.exit(1);
    }
}

function safe<A>(fn: (a: A) => Promise<unknown>): (a: A) => Promise<TToolResult> {
    return async (a: A) => {
        try {
            return ok(await fn(a));
        } catch (e) {
            return fail(errMsg(e));
        }
    };
}

server.tool('connect_neurocenter','Подключить этот компьютер к Нейроцентру; действующая привязка сохраняется. reconnect=true — подтвердить подключение заново для продления или смены роли.',z.object({reconnect:z.boolean().optional()}).shape,safe(async(input:{reconnect?:boolean})=>connectBridge(true,input.reconnect)));
server.tool('neurocenter_bridge_status','Проверить локальную привязку MCP и папки проектов; секрет подключения не возвращается.',z.object({}).shape,safe(async()=>{const credentials=await readState<Credentials>('credentials');return {connected:!!credentials,deviceId:credentials?.deviceId,...await workspaceReport()};}));

server.tool(
    'scan_skills',
    'Скан opencode-скиллов: .opencode/skills/**/SKILL.md → карточки (name/slug/scope/projectId/mcp/plugins/tags/version) + ошибки парсинга.',
    scanSkillsInputSchema.shape,
    safe(async (i: TScanSkillsInput) =>
        scanSkills(i.root ? path.resolve(cwd, i.root) : cwd, i.maxDepth),
    ),
);

server.tool(
    'sync_skills',
    'Синхронизация скиллов проекта в панель: scan .opencode/skills → POST /api/skills/sync (в каталог project-<projectKey>). dryRun — только список.',
    syncSkillsInputSchema.shape,
    safe(async (i: TSyncSkillsInput) => syncSkills(i)),
);

server.tool(
    'scan_plugins',
    'Скан opencode-плагинов: MCP-серверы из opencode.json (mcp[]) + каталоги плагинов (.opencode/plugins, ~/.config/opencode/plugins).',
    scanPluginsInputSchema.shape,
    safe(async (i: TScanPluginsInput) => scanPlugins(i.configPath, cwd)),
);

server.tool(
    'detect_project',
    'Определяет проект и локализует opencode-rag.json + rag_db (LanceDB): привязка db↔конфиг, embedding-провайдер/модель, git/package/AGENTS.md, projectKey (если задан).',
    detectProjectInputSchema.shape,
    safe(async (i: TDetectProjectInput) => detectProjectTool(i, cwd)),
);

server.tool(
    'rag_db_inspect',
    'Инспекция rag_db (LanceDB) на уровне конфига + footprint: store-путь, таблицы, aux-файлы (quirks и др.), кол-во/размер data-файлов, версии. Без чтения бинарных таблиц.',
    ragDbInspectInputSchema.shape,
    safe(async (i: TRagDbInspectInput) => ragDbInspect(i, cwd)),
);

server.tool(
    'rag_db_diff',
    'Дельта rag_db (LanceDB): локальный fingerprint-set (id + sha256(content)) → added/changed/removed против baseline (JSON-снимок сервера, если задан). dimension/rowCount, byFile, sample. read-only, батчами (без эмбеддингов).',
    ragDbDiffInputSchema.shape,
    safe(async (i: TRagDbDiffInput) => ragDbDiff(i, cwd)),
);

server.tool(
    'resolve_project_key',
    'Читает серверный projectKey из явной локальной привязки .opencode/neurocenter.json. Папка связывается на странице «Проекты»; её название не определяет ID и не создаёт серверный проект.',
    resolveProjectKeyInputSchema.shape,
    safe(async (i: TResolveProjectKeyInput) => resolveProjectKey(i, cwd)),
);

server.tool(
    'sync_rag_db',
    'Дельта-синхронизация rag_db (LanceDB) → develop-базовая копия (Postgres/pgvector). added/changed/removed против server-manifest; dryRun=только план; дельта > maxRows (1000) не применяется автоматически (preview). write/idempotent.',
    syncRagDbInputSchema.shape,
    safe(async (i: TSyncRagDbInput) => syncRagDb(i, cwd)),
);

server.tool(
    'scan_workspaces',
    'Скан локальных проектов (деф. ~/projects/*): что уже установлено где — скиллы (.opencode/skills), MCP (opencode.json → mcp), плагины (.opencode/plugins). Фильтр по названию проекта (query). Используется для баджей «Установлено» в панели.',
    scanWorkspacesInputSchema.shape,
    safe(async (i: TScanWorkspacesInput) => scanWorkspaces(i)),
);

server.tool(
    'list_bundle_versions',
    'Версии бандла MCP/плагина (immutable history) из каталога: по plugin (id/имя) → список {version, files(кол-во), author, note, createdAt}.',
    bundleVersionsInputSchema.shape,
    safe(async (i: TBundleVersionsInput) => listBundleVersions(i)),
);

server.tool(
    'read_bundle_file',
    'Содержимое файла бандла (head или конкретная версия): plugin + path (относит.) + version (опц.) → {path, size, digest, content}.',
    bundleFileInputSchema.shape,
    safe(async (i: TBundleFileInput) => readBundleFile(i)),
);

server.tool(
    'activate_bundle_version',
    'Откат бандла к версии (make head): plugin + version → новая head-версия. Роллбэк/форовард между сохранёнными версиями.',
    bundleActivateInputSchema.shape,
    safe(async (i: TBundleActivateInput) => activateBundleVersion(i)),
);

server.tool(
    'restore_rag_db',
    'Обратная синхронизация: скачивает develop-индекс из postgres/pgvector (GET /api/rag/chunks) и записывает в локальную LanceDB-базу проекта (создаёт таблицу chunks или делает merge-insert). Нужна когда локальный rag_db пуст/отсутствует.',
    restoreRagDbInputSchema.shape,
    safe(async (i: TRestoreRagDbInput) => restoreRagDb(i, cwd)),
);

const transport = new StdioServerTransport();
if(await readState<Credentials>('credentials')){startWorker();}
await server.connect(transport);
process.stderr.write('neurocenter-asset-sync: stdio MCP server ready\n');
