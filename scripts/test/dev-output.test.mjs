import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createDevOutput} from '../workspace/dev-output.mjs';

/** Отдельные потоки позволяют проверить цвета без настоящего терминала. */
function capture({tty = false, errorTty = tty, env = {TERM: 'xterm-256color'}} = {}) {
    let output = '', errors = '';
    const stdout = {isTTY: tty, write: value => {output += value; return true;}};
    const stderr = {isTTY: errorTty, write: value => {errors += value; return true;}};
    return {out: createDevOutput({stdout, stderr, env}), stdout: () => output, stderr: () => errors};
}

const ansi = /\x1b\[[0-9;]*m/;

test('Вывод сохраняет смысл этапов, адресов, состояния сервисов и логов', () => {
    const f = capture();
    f.out.heading('Нейроцентр', 'Локальная разработка');
    f.out.step(2, 7, 'Сборка каталога');
    f.out.success('Сборка завершена');
    f.out.info('Интерфейс', 'http://localhost:5173');
    f.out.service({name: 'gateway', label: 'API-шлюз', port: 4000, ok: true});
    f.out.service({name: 'rag', label: 'База знаний', port: 4300, ok: false});
    f.out.logs('API-шлюз', 'Первое событие\nВторое событие');
    const output = f.stdout();
    for (const fragment of ['Нейроцентр', 'Локальная разработка', 'Сборка каталога', 'Сборка завершена',
        'Интерфейс', 'http://localhost:5173', 'API-шлюз', '4000', 'База знаний', '4300', 'Первое событие', 'Второе событие']) {
        assert.ok(output.includes(fragment), fragment);
    }
    assert.match(output, /2\s*\/\s*7/);
    assert.match(output, /готов/);
    assert.match(output, /недоступ/);
    assert.equal(f.stderr(), '');
    assert.doesNotMatch(output, ansi);
});

test('Предупреждения и ошибки видны отдельно от обычного вывода', () => {
    const f = capture();
    f.out.warning('Docker пока недоступен');
    f.out.error('Сборка остановлена');
    assert.match(f.stderr(), /Docker пока недоступен/);
    assert.match(f.stderr(), /Сборка остановлена/);
    assert.equal(f.stdout(), '');
});

test('Цвета включаются для терминала и не попадают в перенаправленный поток', () => {
    const f = capture({tty: true, errorTty: false});
    f.out.success('Готово');
    f.out.error('Ошибка');
    assert.match(f.stdout(), ansi);
    assert.doesNotMatch(f.stderr(), ansi);
});

for (const env of [{TERM: 'xterm', NO_COLOR: '1'}, {TERM: 'xterm', NO_COLOR: ''}, {TERM: 'dumb'}]) {
    test(`Настройки ${JSON.stringify(env)} отключают цвета даже в терминале`, () => {
        const f = capture({tty: true, env});
        f.out.heading('Нейроцентр');
        f.out.success('Готово');
        f.out.warning('Предупреждение');
        f.out.error('Ошибка');
        assert.doesNotMatch(f.stdout() + f.stderr(), ansi);
    });
}

test('Справка объясняет все команды локального стека', () => {
    const f = capture();
    f.out.help();
    const output = f.stdout();
    assert.match(output, /scripts\/dev\.sh/);
    for (const command of ['install', 'build', 'check', 'up', 'down', 'status', 'tail']) {
        assert.match(output, new RegExp(`\\b${command}\\b`));
    }
    assert.match(output, /[А-Яа-яЁё]/);
    assert.equal(f.stderr(), '');
});
