import assert from 'node:assert/strict';
import { test } from 'node:test';
import source from '../../services/shared/tool-runtime-source.cjs';

const asset = { url: 'https://github.com/owner/tool/releases/download/v1/tool.tar.gz', sha256: 'a'.repeat(64), format: 'tar.gz', entrypoint: 'bin/runtime' };
const runtime = (adapter, app = { directory: 'app', entrypoint: { python: 'main.py', java: 'app.jar', dotnet: 'app.dll' }[adapter] ?? 'tool' }) => ({
    type: 'runtime', adapter, assets: { 'darwin-arm64': { app, ...(['python', 'java', 'dotnet'].includes(adapter) ? { runtime: asset } : {}) } },
});

test('Все шесть адаптеров описывают автономную поставку с точным набором платформ', () => {
    for (const adapter of ['python', 'java', 'dotnet', 'go', 'rust', 'native']) {
        const value = runtime(adapter);
        assert.deepEqual(source.validateRuntimeSource(value), value);
        assert.deepEqual(source.runtimeSourceTargets(value), ['darwin-arm64']);
        assert.ok(source.runtimeAdapterLabel(adapter));
    }
});

test('Runtime и расширение приложения соответствуют adapter, неизвестные поля и shell-команды запрещены', () => {
    for (const value of [
        { ...runtime('python'), command: 'python' }, { ...runtime('ruby'), adapter: 'ruby' },
        { ...runtime('python'), assets: { 'darwin-arm64': { app: { directory: 'app', entrypoint: 'main.py' } } } },
        { ...runtime('native'), assets: { 'darwin-arm64': { app: { directory: 'app', entrypoint: 'tool' }, runtime: asset } } },
        runtime('python', { directory: '../private', entrypoint: 'main.py' }), runtime('java', { directory: 'app', entrypoint: 'main.py' }),
        runtime('native', { directory: 'app', entrypoint: 'install.sh' }), runtime('native', { directory: 'app', entrypoint: 'tool', args: ['--shell'] }),
        runtime('native', { ...asset, directory: 'app' }), runtime('native', { ...asset, sha256: 'latest' }),
    ]) { assert.throws(() => source.validateRuntimeSource(value)); }
});

test('Asset URL и DNS исключают локальные, private и зарезервированные адреса', () => {
    for (const url of ['http://github.com/a', 'https://localhost/a', 'https://internal.local/a', 'https://127.0.0.1/a', 'https://2130706433/a',
        'https://10.0.0.1/a', 'https://169.254.169.254/a', 'https://token@github.com/a', 'https://github.com:444/a', 'https://github.com/a#fragment']) {
        assert.throws(() => source.validateRuntimeSource(runtime('native', { ...asset, url })));
    }
    for (const address of ['127.0.0.1', '10.1.2.3', '100.64.1.1', '169.254.1.1', '172.16.0.1', '192.168.1.1', '192.0.2.1', '198.18.0.1', '203.0.113.1', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2001:db8::1']) {
        assert.equal(source.isPublicRuntimeAddress(address), false, address);
    }
    assert.equal(source.isPublicRuntimeAddress('8.8.8.8'), true);
    assert.equal(source.isPublicRuntimeAddress('2606:4700:4700::1111'), true);
});
