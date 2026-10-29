const clean = value => String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');

/** Общий вывод dev-команд: цвета только в TTY, сообщения об ошибках — в stderr. */
export function createDevOutput({stdout = process.stdout, stderr = process.stderr, env = process.env, defaultProfile} = {}) {
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
            output.info('Использование', 'scripts/dev.sh <команда> [--profile fast|standard|full]');
            line('');
            for (const [command, description] of [
                ['install', 'Подготовить Compose и зависимости основных приложений'],
                ['build', 'Собрать основные сервисы и интерфейс'],
                ['check', 'Выполнить проверки проекта'],
                ['up', 'Собрать и запустить проект'],
                ['watch', 'Запустить с последовательной пересборкой изменённых сервисов'],
                ['down', 'Остановить локальные процессы, сохранив PostgreSQL и данные'],
                ['status', 'Проверить готовность сервисов'],
                ['tail', 'Показать последние 20 строк логов каждого сервиса'],
            ]) { line(`  ${paint(stdout, '1', command.padEnd(10))} ${description}`); }
            line('\n  Пересборка при изменениях: scripts/dev.sh up --watch (или scripts/dev.sh watch).');
            line('  Статус — status; остановка watcher и его сервисов — down. npm ci на изменениях не выполняется.');
            line('\n  Профиль выбирается для install/build/up/watch:');
            line('    up --profile fast      основные приложения, без ассетов, упаковки моста и проверщика снимков');
            line('    up --profile standard  мост и инструменты, без загрузки весов и запуска моделей');
            line('    up --profile full      инструменты и запуск уже подготовленного хостинга моделей');
            if(defaultProfile)output.info('Профиль без параметров',defaultProfile);
            line('  Веса моделей не скачиваются ни одним профилем; добавьте GGUF или архив вручную.');
            line('  Full не скачивает и не собирает образ хостинга: нужен подготовленный локальный runtime.');
            line('  Fast одинаков в терминале и без TTY; компоненты добавляются архивом на странице «Ассеты».');
            line('  Npm и Docker могут обращаться к сети во всех профилях; доступ к хранилищу ассетов для fast не нужен.');
            line('  Проверщик снимков и поставку моста готовит install --profile standard; запускает up --profile standard.');
            line('  Кэш и уже работающий хостинг моделей сохраняются при выборе лёгкого профиля.');
            line('  Подготовка файлов не добавляет карточки: состав общего каталога выбирается в «Ассетах».');
            line('');
            output.info('Требования', 'Node.js 24, npm, Git и Docker; Compose подготовит install');
            line('\n  Первый запуск:');
            line('    scripts/dev.sh install');
            line('    scripts/dev.sh up');
            line('\n  Справка: scripts/dev.sh --help\n');
        },
    };
    return output;
}
