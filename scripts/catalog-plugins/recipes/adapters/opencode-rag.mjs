import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Только управляемые команды: MCP остаётся stdio-процессом своего клиента. */
export async function runManagedRagCli(args = process.argv.slice(2)) {
    if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
        console.log('Использование: opencode-rag mcp | opencode-rag ui [--port 0|1024–65535] [--no-open]');
        return;
    }
    if (args[0] === 'mcp' && args.length === 1) { await import('./rag-mcp.mjs'); return; }
    if (args[0] !== 'ui') { throw new Error('Доступны команды opencode-rag mcp и opencode-rag ui.'); }
    let port = 3210; const seen = new Set();
    for (let index = 1; index < args.length; index++) {
        const option = args[index];
        if (seen.has(option)) { throw new Error('Параметр UI указан повторно.'); }
        seen.add(option);
        if (option === '--no-open') { continue; }
        if (option !== '--port' || !/^(?:0|[1-9][0-9]*)$/.test(args[index + 1] || '')) { throw new Error('Для UI допустимы только --port и --no-open.'); }
        port = Number(args[++index]);
        if (port !== 0 && (port < 1024 || port > 65535)) { throw new Error('Порт UI: 0 или целое число от 1024 до 65535.'); }
    }
    const { runManagedRagUi } = await import('./rag-ui.mjs');
    await runManagedRagUi({ port });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    runManagedRagCli().catch(() => { console.error('OpenCodeRAG не запущен. Проверьте папку проекта, локальный индекс и настройки подключения.'); process.exitCode = 1; });
}
