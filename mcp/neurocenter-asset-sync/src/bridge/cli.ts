import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { connectBridge } from './connect.js';
import { atomicText } from './atomic-file.js';
import { apiHub, hub } from './state.js';
import { BRIDGE_VERSION } from './protocol.js';

const directory = fileURLToPath(new URL('../../', import.meta.url));
const marker = 'Neurocenter bridge command v1';
const clean = (value: string): string => value.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
const quote = (value: string): string => "'" + value.replace(/'/g, "'\"'\"'") + "'";
function origin(value: unknown): string {
    if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x20\x7f]/.test(value)) throw Error('Укажите HTTP(S)-адрес сервера без ключей и параметров.');
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || value !== url.origin || url.username || url.password) throw Error('Укажите HTTP(S) origin сервера без ключей и параметров.');
    return url.origin;
}
/** The small launcher uses the bundled runtime, so PATH and system Node versions cannot change the installation. */
export async function installBridgeCommand(options: { directory?: string; binDirectory?: string; windows?: boolean } = {}): Promise<string> {
    const root = options.directory ?? directory, bin = options.binDirectory ?? path.join(os.homedir(), '.local', 'bin'), windows = options.windows ?? process.platform === 'win32';
    const settings = { schemaVersion: 1, siteUrl: origin(hub()), apiUrl: origin(apiHub()) };
    await atomicText(path.join(root, 'installation.json'), JSON.stringify(settings) + '\n', 0o600);
    await fs.mkdir(bin, { recursive: true });
    const target = path.join(bin, 'neurocenter-bridge' + (windows ? '.cmd' : ''));
    try { if (!(await fs.readFile(target, 'utf8')).includes(marker)) throw Error('Команда neurocenter-bridge уже занята другой программой. Укажите отдельный каталог команд.'); }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause; }
    const node = path.join(root, 'bin', windows ? 'node.exe' : 'node'), entry = path.join(root, 'dist', 'bridge-cli.js');
    const escapeWindows = (value: string): string => value.replace(/%/g, '%%');
    const source = windows ? `@echo off\r\nsetlocal DisableDelayedExpansion\r\nrem ${marker}\r\nif not exist "${escapeWindows(node)}" goto missing\r\nif not exist "${escapeWindows(entry)}" goto missing\r\n"${escapeWindows(node)}" "${escapeWindows(entry)}" %*\r\nexit /b %errorlevel%\r\n:missing\r\necho Bridge missing. Reinstall from Neurocenter Start page. 1>&2\r\nexit /b 1\r\n`
        : `#!/bin/sh\n# ${marker}\nif [ ! -x ${quote(node)} ] || [ ! -f ${quote(entry)} ]; then\n  printf '%s\\n' 'Мост не найден или повреждён. Повторите установку на странице «Начало работы».' >&2\n  exit 1\nfi\nexec ${quote(node)} ${quote(entry)} "$@"\n`;
    await atomicText(target, source, 0o755); return target;
}
/** Connection output is intended for a person; the existing index CLI keeps its machine JSON contract. */
export async function runBridgeCli(args: string[], dependencies = { connect: connectBridge, write: (text: string) => process.stdout.write(text), settingsPath: path.join(directory, 'installation.json') }): Promise<void> {
    const command = args[0] ?? '--help';
    if (command === '--version') { dependencies.write(BRIDGE_VERSION + '\n'); return; }
    if (['--help', '-h', 'help'].includes(command)) {
        dependencies.write('Нейроцентр · мост\n\nneurocenter-bridge connect --open\n  Подключить компьютер или продолжить подтверждение в браузере.\nneurocenter-bridge connect --open --reconnect\n  Подтвердить подключение заново для другого профиля или роли.\n\nАдрес сервера сохраняется при установке. Для другой площадки используйте её установщик.\n'); return;
    }
    if (command === '--install-command') { if (args.length !== 1) throw Error('Лишние аргументы регистрации команды.'); dependencies.write(await installBridgeCommand() + '\n'); return; }
    if (command !== 'connect' || args.slice(1).some(argument => !['--open', '--reconnect'].includes(argument)) || new Set(args).size !== args.length) throw Error('Неизвестная команда. Используйте neurocenter-bridge --help.');
    if (!process.env.NEUROCENTER_URL) {
        let settings: { schemaVersion?: unknown; siteUrl?: unknown; apiUrl?: unknown };
        try { settings = JSON.parse(await fs.readFile(dependencies.settingsPath, 'utf8')); }
        catch { throw Error('Адрес площадки не настроен. Повторите установку моста на странице «Начало работы».'); }
        if (settings.schemaVersion !== 1) throw Error('Настройка команды устарела. Обновите мост.');
        process.env.NEUROCENTER_URL = origin(settings.siteUrl);
        process.env.NEUROCENTER_API_URL = origin(settings.apiUrl);
    } else { origin(hub()); origin(apiHub()); }
    const result = await dependencies.connect(args.includes('--open'), args.includes('--reconnect'));
    if ('connected' in result && result.connected === true) {
        dependencies.write('✓ Компьютер подключён к Нейроцентру. Существующее подключение сохранено.\nВыберите папку проекта на сайте.\n'); return;
    }
    if (!('url' in result) || typeof result.url !== 'string' || typeof result.code !== 'string' || new URL(result.url).origin !== hub()) throw Error('Мост не подтвердил подключение. Повторите команду после проверки сервера.');
    dependencies.write('Компьютер ожидает подтверждения.\n' + (result.browserOpened ? 'Страница открыта в браузере.\n' : 'Откройте страницу:\n')
        + clean(result.url) + '\nКод: ' + clean(result.code) + '\n' + (result.fingerprint ? 'Отпечаток: ' + clean(result.fingerprint) + '\n' : '') + 'Сверьте имя и отпечаток компьютера и подтвердите доступ на сайте.\n');
}
