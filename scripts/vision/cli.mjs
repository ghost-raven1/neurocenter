import {configuration} from '../embedding/config.mjs';
import {up,check,status,compose,withControlLock} from '../embedding/runtime.mjs';
import {probeVision} from './client.mjs';

/** Первая CPU-проба занимает несколько минут; показываем текущий этап до запроса. */
function readiness(config) {
    console.log('Проверяем распознавание тестовой картинки. На CPU это может занять несколько минут…');
    return probeVision(config);
}

async function main() {
    const config = configuration(process.env, undefined, 'vision');
    const command = process.argv[2];
    if (command === 'up') {
        console.log(`Подготавливаем ${config.lock.model} в проектном хостинге моделей.`);
        let previous = '';
        const receipt = await up(config, value => {
            const percent = value.total > 0 ? Math.floor(100 * (value.completed || 0) / value.total / 5) * 5 : undefined;
            const message = value.status + (percent === undefined ? '' : ` — ${percent}%`);
            if (message !== previous) {console.log(message); previous = message;}
        }, readiness);
        console.log(`Vision готов: ${receipt.model}. Число и цвет тестовой картинки распознаны.\nAPI: ${config.baseUrl}/api/chat\nОбработка файла: npm run vision:describe -- ./image.png`);
    } else if (command === 'check') {
        const receipt = await withControlLock(config, () => check(config, readiness));
        console.log(`Проверка картинки пройдена: ${receipt.model}; ${receipt.checkedAt}`);
    } else if (command === 'status') {
        const result = await status(config); console.log(JSON.stringify(result, null, 2));
        if (result.state !== 'verified') process.exitCode = 1;
    } else if (command === 'down') {
        await withControlLock(config, () => compose(config, ['down'], {inherit: true}));
        console.log('Общий хостинг vision и embedding остановлен. Все веса сохранены в data/embedding.');
    } else throw new Error('Использование: npm run vision:up | vision:check | vision:status | vision:down');
}

main().catch(error => {console.error(error.message); process.exitCode = 1;});
