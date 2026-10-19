import path from 'node:path';
import {fileURLToPath} from 'node:url';

const commands = ['up', 'check', 'status', 'down'];
const helpFlags = ['--help', '-h'];
const usage = profile => `Использование: npm run ${profile}:up | ${profile}:check | ${profile}:status | ${profile}:down`;

async function execute(profile, args) {
    if (args.length === 1 && helpFlags.includes(args[0])
        || args.length === 2 && commands.includes(args[0]) && helpFlags.includes(args[1])) {
        console.log(`${usage(profile)}\n\nup — подготовить модель и проверить её.\ncheck — выполнить содержательную проверку.\n`
            + 'status — показать последнюю проверку без inference.\ndown — остановить общий хостинг embedding и vision с сохранением весов.');
        return;
    }
    if (args.length !== 1 || !commands.includes(args[0])) {
        throw new Error(`${usage(profile)}\nСправка: npm run ${profile}:up -- --help`);
    }
    const command = args[0];
    const {configuration} = await import('../embedding/config.mjs');
    const config = configuration(process.env, undefined, profile);
    const {up, check, status, compose, withControlLock} = await import('../embedding/runtime.mjs');
    let probe;
    if (profile === 'vision' && ['up', 'check'].includes(command)) {
        const {probeVision} = await import('../vision/client.mjs');
        probe = current => {
            console.log('Проверяем распознавание тестовой картинки. На CPU это может занять несколько минут…');
            return probeVision(current);
        };
    }
    if (command === 'up') {
        console.log(profile === 'vision' ? `Подготавливаем ${config.lock.model} в проектном хостинге моделей.`
            : `Подготавливаем ${config.lock.model}; веса остаются в data/embedding.`);
        let previous = '';
        const receipt = await up(config, value => {
            const percent = value.total > 0 ? Math.floor(100 * (value.completed || 0) / value.total / 5) * 5 : undefined;
            const message = value.status + (percent === undefined ? '' : ` — ${percent}%`);
            if (message !== previous) {console.log(message); previous = message;}
        }, probe);
        console.log(profile === 'vision'
            ? `Vision готов: ${receipt.model}. Число и цвет тестовой картинки распознаны.\nAPI: ${config.baseUrl}/api/chat\nОбработка файла: npm run vision:describe -- ./image.png`
            : `Модель готова: ${receipt.dimension} измерений.\nURL для мастера MCP: ${config.baseUrl}/api\nМодель: ${receipt.model}\nПротокол: ollama`);
    } else if (command === 'check') {
        const receipt = await withControlLock(config, () => check(config, probe));
        console.log(profile === 'vision' ? `Проверка картинки пройдена: ${receipt.model}; ${receipt.checkedAt}`
            : `Проверка пройдена: ${receipt.model}, ${receipt.dimension} измерений; ${receipt.checkedAt}`);
    } else if (command === 'status') {
        const value = await status(config);
        console.log(JSON.stringify(value, null, 2));
        if (value.state !== 'verified') process.exitCode = 1;
    } else {
        await withControlLock(config, () => compose(config, ['down'], {inherit: true}));
        console.log('Общий хостинг embedding и vision остановлен. Все веса сохранены в data/embedding.');
    }
}

/** Один CLI для двух профилей; импорт entrypoint не запускает операции и не читает конфигурацию. */
export async function runModelCli(profile, entryUrl) {
    if (!process.argv[1] || path.resolve(process.argv[1]) !== fileURLToPath(entryUrl)) return;
    try {await execute(profile, process.argv.slice(2));}
    catch (error) {
        console.error(error instanceof Error ? error.message : 'Не удалось выполнить команду локальной модели.');
        process.exitCode = 1;
    }
}
