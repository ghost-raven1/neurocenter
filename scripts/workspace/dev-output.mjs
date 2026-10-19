const clean = value => String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');

/** Общий вывод dev-команд: цвета только в TTY, сообщения об ошибках — в stderr. */
export function createDevOutput({stdout = process.stdout, stderr = process.stderr, env = process.env} = {}) {
    const paint = (stream, code, value) => stream.isTTY && env.TERM !== 'dumb' && !Object.hasOwn(env, 'NO_COLOR')
        ? `\x1b[${code}m${value}\x1b[0m` : value;
    const line = value => stdout.write(`${value}\n`);
    const output = {
        heading(title, subtitle) {
            line(`\n${paint(stdout, '1;36', 'Нейроцентр')} · ${clean(title)}`);
            line(paint(stdout, '2', '─'.repeat(48)));
            if (subtitle) { line(`  ${clean(subtitle)}`); }
        },
        step(index, total, label) { line(`\n${paint(stdout, '36', `[${index}/${total}]`)} ${clean(label)}`); },
        success(text) { line(`  ${paint(stdout, '32', '✓')} ${clean(text)}`); },
        info(label, value) { line(`  ${paint(stdout, '1', `${clean(label)}:`)} ${clean(value)}`); },
        warning(text) { stderr.write(`  ${paint(stderr, '33', '!')} ${clean(text)}\n`); },
        error(text) { stderr.write(`\n  ${paint(stderr, '1;31', '✗ Ошибка:')} ${clean(text)}\n`); },
        service({name, label, port, ok}) {
            const mark = paint(stdout, ok ? '32' : '33', ok ? '✓' : '—');
            line(`  ${mark} ${clean(label || name).padEnd(22)} :${String(port).padEnd(6)} ${ok ? 'готов' : 'недоступен'}`);
        },
        logs(name, text) { line(`\n${paint(stdout, '36', `── ${clean(name)} ──`)}\n${text}`); },
        help() {
            output.heading('Локальная среда', 'Запуск, остановка и проверка проекта');
            output.info('Использование', 'scripts/dev.sh <команда>');
            line('');
            for (const [command, description] of [
                ['install', 'Подготовить Docker Compose и установить зависимости'],
                ['build', 'Собрать сервисы, интерфейс и пакет моста'],
                ['check', 'Выполнить проверки проекта'],
                ['up', 'Собрать и запустить проект'],
                ['down', 'Остановить локальные процессы, сохранив PostgreSQL и данные'],
                ['status', 'Проверить готовность сервисов'],
                ['tail', 'Показать последние 20 строк логов каждого сервиса'],
            ]) { line(`  ${paint(stdout, '1', command.padEnd(10))} ${description}`); }
            line('');
            output.info('Требования', 'Node.js 24+, npm и Docker; Compose подготовит install');
            line('\n  Первый запуск:');
            line('    scripts/dev.sh install');
            line('    scripts/dev.sh up');
            line('\n  Справка: scripts/dev.sh --help\n');
        },
    };
    return output;
}
