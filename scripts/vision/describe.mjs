import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readImageInput, visionQuestion} from './image-input.mjs';

/** Обрабатывает один явно выбранный файл; подготовка модели остаётся отдельной командой. */
export async function describeImage(args = process.argv.slice(2)) {
    if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
        console.log('Использование: npm run vision:describe -- <изображение> ["вопрос"]\n'
            + 'PNG, JPEG или WebP, до 10 МиБ. Если вопрос не указан, модель опишет изображение и прочитает видимый текст.\n'
            + 'Сначала подготовьте локальную модель: npm run vision:up. Эта команда не запускает и не скачивает модель.');
        return;
    }
    if (!args.length || args.length > 2 || args[0].startsWith('-')) {
        throw new Error('Укажите файл и необязательный вопрос в кавычках. Справка: npm run vision:describe -- --help');
    }
    const question = visionQuestion(args[1]);
    const input = await readImageInput(args[0]);
    const {configuration} = await import('../embedding/config.mjs');
    const {visionChat} = await import('./client.mjs');
    const result = await visionChat(configuration(process.env, undefined, 'vision'), {...input, question});
    console.log(result.text);
    if (result.truncated) console.error('Ответ сокращён из-за лимита вывода. Уточните вопрос и повторите запрос.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    describeImage().catch(error => {console.error(error instanceof Error ? error.message : 'Не удалось обработать изображение.'); process.exitCode = 1;});
}
