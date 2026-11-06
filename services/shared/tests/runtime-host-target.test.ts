import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { getHostTarget } = require('../runtime/host-target.cjs') as typeof import('../runtime/host-target.cjs');
const { TARGETS } = require('../runtime/targets.cjs') as typeof import('../runtime/targets.cjs');

test('glibc подтверждается glibcVersionRuntime в ожидаемой форме', () => {
    for (const version of ['2.36', '2.31.9', '2.28'])
        assert.equal(
            getHostTarget({
                platform: 'linux',
                arch: 'x64',
                report: { header: { glibcVersionRuntime: version }, sharedObjects: [] },
            }),
            'linux-x64-glibc',
        );
    for (const version of ['', '2', '2.', '2.3.4.5', 123, null])
        assert.equal(
            getHostTarget({
                platform: 'linux',
                arch: 'x64',
                report: { header: { glibcVersionRuntime: version }, sharedObjects: [] },
            }),
            'linux-x64-unknown',
        );
});

test('musl подтверждается загруженными разделяемыми объектами', () => {
    assert.equal(
        getHostTarget({
            platform: 'linux',
            arch: 'x64',
            report: { header: {}, sharedObjects: ['/lib/ld-musl-x86_64.so.1'] },
        }),
        'linux-x64-musl',
    );
    assert.equal(
        getHostTarget({
            platform: 'linux',
            arch: 'arm64',
            report: { header: {}, sharedObjects: ['/lib/libc.musl-aarch64.so.1'] },
        }),
        'linux-arm64-musl',
    );
});

test('Объекты, не подтверждающие musl, оставляют libc неизвестной', () => {
    for (const sharedObjects of [['/lib/libc.so.6'], ['ld-musl'], ['musl.so'], ['ld-musl-x86_64.so.1.bak'], 'ld-musl'])
        assert.equal(
            getHostTarget({ platform: 'linux', arch: 'x64', report: { header: {}, sharedObjects } }),
            'linux-x64-unknown',
        );
});

test('Неизвестная libc оставляет base-unknown (поведение model.ts)', () => {
    for (const report of [
        {},
        { header: {} },
        { header: {}, sharedObjects: [] },
        { header: { glibcVersionRuntime: '' }, sharedObjects: ['/lib/libc.so.6'] },
    ])
        assert.equal(getHostTarget({ platform: 'linux', arch: 'x64', report }), 'linux-x64-unknown');
});

test('Матричный сценарий: инъектированный report определяет цель хоста без чтения process.report', () => {
    const base = process.platform + '-' + process.arch;
    const expected = process.platform === 'linux' ? base + '-glibc' : base;
    assert.equal(getHostTarget({ report: { header: { glibcVersionRuntime: '2.36' }, sharedObjects: [] } }), expected);
});

test('Без явного report функция использует process.report без подмены libc', () => {
    assert.match(getHostTarget({ platform: 'linux', arch: 'x64' }), /^linux-x64-(glibc|musl|unknown)$/);
});

test('throw-режим подтверждает поддерживаемые цели', () => {
    assert.equal(
        getHostTarget({
            platform: 'linux',
            arch: 'x64',
            report: { header: { glibcVersionRuntime: '2.36' } },
            mode: 'throw',
        }),
        'linux-x64-glibc',
    );
    assert.equal(
        getHostTarget({
            platform: 'linux',
            arch: 'x64',
            report: { header: {}, sharedObjects: ['/lib/ld-musl-x86_64.so.1'] },
            mode: 'throw',
        }),
        'linux-x64-musl',
    );
    assert.equal(getHostTarget({ platform: 'darwin', arch: 'arm64', mode: 'throw' }), 'darwin-arm64');
    assert.equal(getHostTarget({ platform: 'win32', arch: 'x64', mode: 'throw' }), 'win32-x64');
});

test('throw-режим отклоняет неподдерживаемые цели с actionable-сообщением', () => {
    assert.throws(
        () => getHostTarget({ platform: 'linux', arch: 'x64', report: { header: {} }, mode: 'throw' }),
        /Платформа хоста не поддерживается для комплектов: linux-x64\./,
    );
    assert.throws(
        () => getHostTarget({ platform: 'freebsd', arch: 'x64', mode: 'throw' }),
        /Платформа хоста не поддерживается для комплектов: freebsd-x64\./,
    );
    assert.throws(
        () =>
            getHostTarget({
                platform: 'linux',
                arch: 'ppc64',
                report: { header: { glibcVersionRuntime: '2.36' } },
                mode: 'throw',
            }),
        /Платформа хоста не поддерживается для комплектов: linux-ppc64-glibc\./,
    );
    assert.ok(!TARGETS.includes('linux-ppc64-glibc'));
});

test('Чужие платформы не подменяются и не дополняются в unknown-режиме', () => {
    assert.equal(getHostTarget({ platform: 'darwin', arch: 'arm64', report: {} }), 'darwin-arm64');
    assert.equal(getHostTarget({ platform: 'freebsd', arch: 'x64', report: {} }), 'freebsd-x64');
    assert.equal(
        getHostTarget({ platform: 'linux', arch: 'ppc64', report: { header: { glibcVersionRuntime: '2.36' } } }),
        'linux-ppc64-glibc',
    );
    assert.equal(getHostTarget({ platform: 'win32', arch: 'x64', report: {} }), 'win32-x64');
});
