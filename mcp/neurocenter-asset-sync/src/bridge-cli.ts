#!/usr/bin/env node
import { runBridgeCli } from './bridge/cli.js';

try {
    await runBridgeCli(process.argv.slice(2));
} catch (cause) {
    const message =
        cause instanceof Error
            ? cause.message.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 1200)
            : 'Проверьте соединение с сервером и повторите команду.';
    process.stderr.write('Не удалось выполнить команду моста: ' + message + '\n');
    process.exitCode = 1;
}
