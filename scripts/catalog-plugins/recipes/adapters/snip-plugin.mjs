import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const binary = fileURLToPath(new URL('./bin/' + (process.platform === 'win32' ? 'snip.exe' : 'snip'), import.meta.url));

/** Оборачивает команды через upstream hook и абсолютный CLI, без поиска в PATH. */
async function rewrite(command) {
    return new Promise(resolve => {
        const child = execFile(binary, ['hook'], { timeout: 2000, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout) => {
            if (error || !stdout.trim()) return resolve(undefined);
            try {
                const rewritten = JSON.parse(stdout).hookSpecificOutput?.updatedInput?.command;
                // snip hook сам выводит абсолютный путь текущего исполняемого файла.
                resolve(typeof rewritten === 'string' && rewritten !== command ? rewritten : undefined);
            } catch { resolve(undefined); }
        });
        child.stdin?.on('error', () => {});
        child.stdin?.end(JSON.stringify({ tool_name: 'Bash', tool_input: { command } }));
    });
}

/** Сохраняет безопасный passthrough upstream2: сложные shell-конструкции не переписываются. */
export default async function SnipPlugin() {
    const probe = await rewrite('git status');
    if (!probe || !probe.includes(path.basename(binary))) throw new Error('Встроенный snip hook недоступен.');
    return { 'tool.execute.before': async (input, output) => {
        if (input.tool !== 'bash' || typeof output.args?.command !== 'string' || !output.args.command) return;
        const command = await rewrite(output.args.command);
        if (command) output.args.command = command;
    } };
}
