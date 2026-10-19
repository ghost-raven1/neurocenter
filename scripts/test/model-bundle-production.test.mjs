import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runModelBundleSync, modelBundleCli } from '../production/sync-models.mjs';
import { maintenanceLock } from '../production/compose-client.mjs';

const report = downloadOnly => ({ ok: true, downloadOnly, verifyOnly: false, models: 2, files: 9, bytes: 4400000000 });

test('Подготовка моделей использует только выбранный том и свежий init-образ без зависимостей', async () => {
    const calls = [];
    const result = await runModelBundleSync({ run: async (...args) => { calls.push(args); return JSON.stringify(report(true)); } },
        { downloadOnly: true, timeout: 5000 }, { uuid: () => 'fixture' });
    assert.equal(result.models, 2);
    assert.deepEqual(calls, [[['run', '--rm', '--no-deps', '-T', '--pull', 'never', '--name', 'neurocenter-model-bundle-fixture',
        '--label', 'neurocenter.model-bundle=fixture', 'model-volume-init', 'node', modelBundleCli,
        '--directory', '/models', '--download-only'], { timeout: 5000 }]]);
});

test('Активация комплекта не получает режим download-only и подтверждается полным отчётом', async () => {
    let command;
    await runModelBundleSync({ run: async args => { command = args; return JSON.stringify(report(false)); } });
    assert.ok(!command.includes('--download-only'));
    for (const value of ['', JSON.stringify({ ok: true }), JSON.stringify(report(true)), JSON.stringify({ ...report(false), files: 0 }),
        JSON.stringify({ ...report(false), verifyOnly: true }), JSON.stringify({ ...report(false), bytes: -1 })]) {
        await assert.rejects(runModelBundleSync({ run: async () => value }, {}, { docker: async () => '' }));
    }
});

test('Отказ подготовки дожидается удаления только своего контейнера с точными метками', async () => {
    const id = 'c'.repeat(64), commands = [];
    let present = true;
    await assert.rejects(runModelBundleSync({ run: async () => { throw new Error('неверный SHA модели'); } }, {}, {
        uuid: () => 'fixture', docker: async command => {
            commands.push(command);
            if (command[0] === 'ps') {
                assert.ok(command.includes('name=^/neurocenter-model-bundle-fixture$'));
                assert.ok(command.includes('label=neurocenter.model-bundle=fixture'));
                return present ? id : '';
            }
            assert.deepEqual(command, ['rm', '--force', id]);
            present = false; return '';
        },
    }), /SHA/);
    assert.equal(present, false);
    assert.deepEqual(commands.at(-1).slice(0, 2), ['ps', '--all']);
});

test('Неопределённая остановка и чужой ID удерживают блокировку обслуживания', async () => {
    const calls = [];
    await assert.rejects(maintenanceLock({ projectName: 'fixture' }, 'image', 'model-bundle',
        () => runModelBundleSync({ run: async () => { throw new Error('таймаут'); } }, {}, {
            docker: async command => { assert.equal(command[0], 'ps'); return 'неподтверждённый-ID'; },
        }), async command => { calls.push(command); return 'lock-id'; }),
    error => error.retainMaintenanceLock === true && error.message.includes('подготовки моделей'));
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'create');
});
