import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const facade = require('../runtime-artifacts.cjs') as typeof import('../runtime-artifacts.cjs');
const canonical = require('../runtime/targets.cjs') as typeof import('../runtime/targets.cjs');
const { portablePath } = require('../runtime/portable-path.cjs') as typeof import('../runtime/portable-path.cjs');
const install = require('../opencode-cli-install.cjs') as typeof import('../opencode-cli-install.cjs');

test('Фасад identity-реэкспортирует канонические цели и portablePath, не меняя поверхность', () => {
    assert.equal(facade.TARGETS, canonical.TARGETS);
    assert.equal(facade.portablePath, portablePath);
    assert.deepEqual(Object.keys(facade).sort(), [
        'CEILING',
        'LIMITS',
        'LIMIT_DEFAULTS',
        'TARGETS',
        'inspectRuntimeArchive',
        'normalizeRuntimeArtifacts',
        'portablePath',
        'validateRuntimeArtifactEntrypoints',
    ]);
});

test('Канон TARGETS — единственный замороженный список из 8 целей', () => {
    assert.deepEqual(
        [...canonical.TARGETS],
        [
            'darwin-arm64',
            'darwin-x64',
            'linux-arm64-glibc',
            'linux-x64-glibc',
            'linux-arm64-musl',
            'linux-x64-musl',
            'win32-arm64',
            'win32-x64',
        ],
    );
    assert.ok(Object.isFrozen(canonical.TARGETS));
});

test('win32-* и windows-* маппятся явными таблицами в обе стороны', () => {
    assert.equal(canonical.toWindowsTarget('win32-x64'), 'windows-x64');
    assert.equal(canonical.toWindowsTarget('win32-arm64'), 'windows-arm64');
    assert.equal(canonical.toCanonicalTarget('windows-x64'), 'win32-x64');
    assert.equal(canonical.toCanonicalTarget('windows-arm64'), 'win32-arm64');
    assert.throws(() => canonical.toWindowsTarget('linux-x64-glibc'), /windows-аналога/);
    assert.throws(() => canonical.toWindowsTarget('windows-x64'), /windows-аналога/);
    assert.throws(() => canonical.toCanonicalTarget('windows-riscv64'), /Неизвестная платформенная цель/);
    assert.throws(() => canonical.toCanonicalTarget('solaris-x64'), /Неизвестная платформенная цель/);
    assert.throws(() => canonical.toCanonicalTarget('__proto__'), /Неизвестная платформенная цель/);
});

test('Канонические цели маппятся на package-цели явно, win32-* package-аналога не имеют', () => {
    assert.equal(canonical.toPackageTarget('darwin-arm64'), 'darwin-arm64');
    assert.equal(canonical.toPackageTarget('darwin-x64'), 'darwin-x64');
    assert.equal(canonical.toPackageTarget('linux-arm64-glibc'), 'linux-arm64');
    assert.equal(canonical.toPackageTarget('linux-x64-glibc'), 'linux-x64');
    assert.equal(canonical.toPackageTarget('linux-arm64-musl'), 'linux-arm64-musl');
    assert.equal(canonical.toPackageTarget('linux-x64-musl'), 'linux-x64-musl');
    assert.throws(() => canonical.toPackageTarget('win32-x64'), /package-аналога/);
    assert.throws(() => canonical.toPackageTarget('win32-arm64'), /package-аналога/);
    assert.throws(() => canonical.toPackageTarget('linux-x64'), /package-аналога/);
});

test('Package- и windows-имена разрешаются в канон через обратный маппинг', () => {
    assert.equal(canonical.toCanonicalTarget('linux-x64'), 'linux-x64-glibc');
    assert.equal(canonical.toCanonicalTarget('linux-arm64'), 'linux-arm64-glibc');
    assert.equal(canonical.toCanonicalTarget('linux-x64-musl'), 'linux-x64-musl');
    assert.equal(canonical.toCanonicalTarget('linux-arm64-musl'), 'linux-arm64-musl');
    assert.equal(canonical.toCanonicalTarget('darwin-arm64'), 'darwin-arm64');
    assert.equal(canonical.toCanonicalTarget('win32-x64'), 'win32-x64');
    assert.throws(() => canonical.toCanonicalTarget('linux-x64-baseline'), /Неизвестная платформенная цель/);
    assert.throws(() => canonical.toCanonicalTarget(''), /Неизвестная платформенная цель/);
});

test('opencode-cli-install сохраняет package-цели, значения и ошибки без изменений', () => {
    assert.deepEqual(
        [...install.OPENCODE_CLI_INSTALL_TARGETS],
        ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'linux-arm64-musl', 'linux-x64-musl'],
    );
    assert.equal(install.openCodeInstallRuntimeTarget('linux-x64'), 'linux-x64-glibc');
    assert.equal(install.openCodeInstallRuntimeTarget('linux-arm64'), 'linux-arm64-glibc');
    assert.equal(install.openCodeInstallRuntimeTarget('linux-x64-musl'), 'linux-x64-musl');
    assert.equal(install.openCodeInstallRuntimeTarget('linux-arm64-musl'), 'linux-arm64-musl');
    assert.equal(install.openCodeInstallRuntimeTarget('darwin-arm64'), 'darwin-arm64');
    assert.throws(() => install.openCodeInstallRuntimeTarget('linux-x64-glibc'), /Некорректный контекст установки/);
    assert.throws(() => install.openCodeInstallRuntimeTarget('windows-x64'), /Некорректный контекст установки/);
    assert.throws(() => install.openCodeInstallRuntimeTarget('solaris-x64'), /Некорректный контекст установки/);
    assert.deepEqual(install.OPENCODE_CLI_INSTALL_SCHEMAS.supply.properties.target.enum, [
        'darwin-arm64',
        'darwin-x64',
        'linux-arm64',
        'linux-x64',
        'linux-arm64-musl',
        'linux-x64-musl',
    ]);
});

const artifact = (target: string) => ({
    target,
    sha256: 'a'.repeat(64),
    compressedBytes: 1024,
    unpackedBytes: 2048,
    filesCount: 1,
    entrypoint: 'bin/tool.js',
});

test('Валидация фасада использует канонический список целей', () => {
    assert.deepEqual(facade.normalizeRuntimeArtifacts([artifact('linux-x64-glibc')]), [artifact('linux-x64-glibc')]);
    assert.throws(() => facade.normalizeRuntimeArtifacts([artifact('linux-x64')]), /Некорректный или повторяющийся/);
    assert.throws(() => facade.normalizeRuntimeArtifacts([artifact('freebsd-x64')]), /Некорректный или повторяющийся/);
    assert.throws(
        () => facade.normalizeRuntimeArtifacts([artifact('win32-x64-glibc')]),
        /Некорректный или повторяющийся/,
    );
});

test('portablePath сохраняет исходную семантику', () => {
    assert.equal(portablePath('bin/tool.js'), true);
    assert.equal(portablePath('a/b.cjs'), true);
    assert.equal(portablePath(''), false);
    assert.equal(portablePath('/absolute'), false);
    assert.equal(portablePath('win\\path'), false);
    assert.equal(portablePath('a/b/../c'), false);
    assert.equal(portablePath('a/b/.'), false);
    assert.equal(portablePath('a/b/trailing '), false);
    assert.equal(portablePath('a/b/file.'), false);
    assert.equal(portablePath('con.js'), false);
    assert.equal(portablePath('com1.js'), false);
    assert.equal(portablePath('a/b/' + 'x'.repeat(241)), false);
});
