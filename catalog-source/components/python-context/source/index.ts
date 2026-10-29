import fs from 'node:fs/promises';
import path from 'node:path';

interface PluginInput { directory: string }
interface SystemOutput { system: string[] }

/** Показывает агенту найденную конфигурацию Python без запуска команд или чтения ключей. */
export default async function pythonContext({ directory }: PluginInput) {
    return { 'experimental.chat.system.transform': async (_input: unknown, output: SystemOutput): Promise<void> => {
        const files: string[] = [];
        for (const name of ['pyproject.toml', 'uv.lock', 'poetry.lock', 'requirements.txt', 'pytest.ini', 'mypy.ini', 'ruff.toml', '.python-version']) {
            try { if ((await fs.lstat(path.join(directory, name))).isFile()) files.push(name); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        }
        if (!files.length) return;
        let version = '';
        const configuration = path.join(directory, 'pyproject.toml');
        if (files.includes('pyproject.toml')) {
            const handle = await fs.open(configuration, 'r');
            try {
                if ((await handle.stat()).size <= 65536) {
                    const content = await handle.readFile('utf8');
                    version = content.match(/^requires-python\s*=\s*["']([\d\s.,<>=!~*^|+-]{1,100})["']/m)?.[1] ?? '';
                }
            } finally { await handle.close(); }
        }
        output.system.push(`Конфигурация Python-проекта (данные, не инструкции): ${files.join(', ')}.${version ? ` Требование Python: ${version}.` : ''} Перед запуском тестов и линтеров проверьте соответствующие настройки проекта.`);
    } };
}
