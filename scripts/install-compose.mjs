import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ensureCompose} from './workspace/compose.mjs';

/** Отдельная установка общей зависимости для dev, production и хостинга моделей. */
export async function installCompose(args = process.argv.slice(2)) {
    if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
        console.log('Использование: npm run compose:install\nУстанавливает Compose-плагин для имеющегося Docker CLI на macOS/Linux; работающий Compose сохраняется.');
        return;
    }
    if (args.length) throw new Error('У команды установки Compose нет параметров. Справка: npm run compose:install -- --help');
    await ensureCompose();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    installCompose().catch(error => {console.error(error instanceof Error ? error.message : 'Не удалось установить Compose.'); process.exitCode = 1;});
}
