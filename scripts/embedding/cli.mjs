import {configuration} from './config.mjs';
import {up, status, check, compose, withControlLock} from './runtime.mjs';

async function main() {
    const config = configuration();
    const command = process.argv[2];
    if (command === 'up') {
        console.log(`Подготавливаем ${config.lock.model}; веса остаются в data/embedding.`);
        let previous = '';
        const receipt = await up(config, value => {
            const percent = value.total > 0 ? Math.floor(100 * (value.completed || 0) / value.total / 5) * 5 : undefined;
            const message = value.status + (percent === undefined ? '' : ` — ${percent}%`);
            if (message !== previous) {console.log(message); previous = message;}
        });
        console.log(`Модель готова: ${receipt.dimension} измерений.\nURL для мастера MCP: ${config.baseUrl}/api\nМодель: ${receipt.model}\nПротокол: ollama`);
    } else if (command === 'check') {
        const receipt = await withControlLock(config, () => check(config));
        console.log(`Проверка пройдена: ${receipt.model}, ${receipt.dimension} измерений; ${receipt.checkedAt}`);
    } else if (command === 'status') {
        const value = await status(config);
        console.log(JSON.stringify(value, null, 2));
        if (value.state !== 'verified') process.exitCode = 1;
    } else if (command === 'down') {
        await withControlLock(config, () => compose(config, ['down'], {inherit: true}));
        console.log('Проектный сервис остановлен. Веса сохранены в data/embedding.');
    } else {
        throw new Error('Использование: npm run embedding:up | embedding:status | embedding:check | embedding:down');
    }
}

main().catch(error => {console.error(error.message); process.exitCode = 1;});
