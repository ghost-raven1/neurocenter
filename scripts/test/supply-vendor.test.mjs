// AD-15, unit-тесты scripts/supply/vendor.mjs:
//   - чистые функции (expectedDigests, flatName, npmjsTarballUrl);
//   - --add в песочнице (NC_SUPPLY_ROOT): flat-расклад, fetch-script-расклад,
//     digest-расхождение (стоп + exit 1, запись не происходит), неизвестные файлы;
//   - --check в реальном состоянии репозитория (счётчики — якоря состояния).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expectedDigests, flatName, npmjsTarballUrl } from '../supply/vendor.mjs';
import { vendorPath } from '../supply/registry.mjs';

const pexecFile = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
const vendorCli = path.join(root, 'scripts/supply/vendor.mjs');
const node = process.execPath;

const sri512 = (bytes) => 'sha512-' + createHash('sha512').update(bytes).digest('base64');

async function runVendor(args, env = {}) {
    return pexecFile(node, [vendorCli, ...args], {
        env: { ...process.env, ...env },
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
    }).then(
        (r) => ({ code: 0, out: r.stdout, err: r.stderr }),
        (e) => ({ code: typeof e.code === 'number' ? e.code : 1, out: e.stdout ?? '', err: e.stderr ?? '' }),
    );
}

/** Песочница: supply/ (vendor + vendor-pending) с pending-строками под NC_SUPPLY_ROOT. */
function seedSandbox(pendingRows) {
    const sb = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-vendor-sb-'));
    const manifest = {
        schemaVersion: 1,
        generatedBy: 'test-fixture',
        packages: pendingRows.map((row) => ({
            name: row.name,
            version: row.version,
            path: vendorPath(row.name, row.version),
            integrity: [row.sri],
            sha512: null,
            status: 'pending',
        })),
    };
    const needed = {
        schemaVersion: 1,
        generatedBy: 'test-fixture',
        packages: pendingRows.map((row) => ({
            name: row.name,
            version: row.version,
            path: vendorPath(row.name, row.version),
            url: npmjsTarballUrl(row.name, row.version),
            expected: expectedDigests(new Set([row.sri])),
        })),
    };
    fs.mkdirSync(path.join(sb, 'vendor'), { recursive: true });
    fs.writeFileSync(path.join(sb, 'vendor/manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    fs.mkdirSync(path.join(sb, 'vendor-pending'), { recursive: true });
    fs.writeFileSync(path.join(sb, 'vendor-pending/needed.json'), JSON.stringify(needed, null, 2) + '\n');
    return sb;
}

test('expectedDigests: hex — это сам digest (регрессия: был хеш от digest-байтов)', () => {
    const sri = 'sha512-OijrAUu7rrJhSIoHNg6LMPS5e344nwUHA+1EFYYjrh64D+GmytUsfBQjci45TjT+rd5Spsp8B5xsZDT+TgyXXQ==';
    const [digest] = expectedDigests(new Set([sri]));
    assert.equal(digest.algorithm, 'sha512');
    assert.equal(digest.sri, sri);
    assert.equal(digest.hex, Buffer.from(sri.slice(7), 'base64').toString('hex'));
    assert.notEqual(digest.hex, createHash('sha512').update(Buffer.from(sri.slice(7), 'base64')).digest('hex'));
});

test('flatName/npmjsTarballUrl: канонические формы', () => {
    assert.equal(flatName('@opencode-ai/sdk', '1.14.48'), '@opencode-ai-sdk-1.14.48.tgz');
    assert.equal(flatName('uuid', '13.0.2'), 'uuid-13.0.2.tgz');
    assert.equal(npmjsTarballUrl('@opencode-ai/plugin', '1.14.48'), 'https://registry.npmjs.org/@opencode-ai/plugin/-/plugin-1.14.48.tgz');
});

test('--add: flat-расклад (расклад оркестратора) принимается, manifest и vendor-pending обновляются', async () => {
    const bytes = Buffer.from('fake tarball @scope/pkg-1.0.0');
    const sb = seedSandbox([{ name: '@scope/pkg', version: '1.0.0', sri: sri512(bytes) }]);
    const src = path.join(sb, 'src');
    fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, flatName('@scope/pkg', '1.0.0')), bytes);
    try {
        const r = await runVendor(['--add', src], { NC_SUPPLY_ROOT: sb });
        assert.equal(r.code, 0, r.out + r.err);
        assert.match(r.out, /Добавлено: 1; неизвестных файлов: 0; ошибок: 0/);
        const target = path.join(sb, 'vendor', '@scope/pkg-1.0.0.tgz');
        assert.ok(fs.existsSync(target), 'тарбол не записан в supply/vendor/');
        assert.deepEqual(fs.readFileSync(target), bytes);
        const manifest = JSON.parse(fs.readFileSync(path.join(sb, 'vendor/manifest.json'), 'utf8'));
        assert.equal(manifest.packages[0].status, 'vendored');
        assert.equal(manifest.packages[0].sha512, sri512(bytes));
        const needed = JSON.parse(fs.readFileSync(path.join(sb, 'vendor-pending/needed.json'), 'utf8'));
        assert.equal(needed.packages.length, 0, 'vendor-pending не обновлён после --add');
    } finally {
        fs.rmSync(sb, { recursive: true, force: true });
    }
});

test('--add: fetch-script-расклад (путь = row.path относительно каталога) принимается', async () => {
    const bytes = Buffer.from('fake tarball uuid-13.0.2');
    const sb = seedSandbox([{ name: 'uuid', version: '13.0.2', sri: sri512(bytes) }]);
    const src = path.join(sb, 'src');
    // Расклад fetch-скрипта: $OUT/<row.path>, т.е. src/supply/vendor/uuid-13.0.2.tgz.
    const rel = vendorPath('uuid', '13.0.2');
    fs.mkdirSync(path.join(src, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(src, rel), bytes);
    try {
        const r = await runVendor(['--add', src], { NC_SUPPLY_ROOT: sb });
        assert.equal(r.code, 0, r.out + r.err);
        assert.match(r.out, /Добавлено: 1/);
        assert.ok(fs.existsSync(path.join(sb, 'vendor/uuid-13.0.2.tgz')));
    } finally {
        fs.rmSync(sb, { recursive: true, force: true });
    }
});

test('--add: digest-расхождение — стоп (exit 1), файл не записан, статус pending сохранён', async () => {
    const good = Buffer.from('good bytes @scope/pkg');
    const bad = Buffer.from('corrupted bytes @scope/pkg');
    const sb = seedSandbox([{ name: '@scope/pkg', version: '1.0.0', sri: sri512(good) }]);
    const src = path.join(sb, 'src');
    fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, flatName('@scope/pkg', '1.0.0')), bad);
    try {
        const r = await runVendor(['--add', src], { NC_SUPPLY_ROOT: sb });
        assert.equal(r.code, 1, 'ожидался exit 1: ' + r.out + r.err);
        assert.match(r.err + r.out, /digest не совпадает: sha512/);
        assert.ok(!fs.existsSync(path.join(sb, 'vendor/@scope/pkg-1.0.0.tgz')), 'файл с неверным digest не должен записаться');
        const manifest = JSON.parse(fs.readFileSync(path.join(sb, 'vendor/manifest.json'), 'utf8'));
        assert.equal(manifest.packages[0].status, 'pending');
        const needed = JSON.parse(fs.readFileSync(path.join(sb, 'vendor-pending/needed.json'), 'utf8'));
        assert.equal(needed.packages.length, 1, 'pending-документация должна остаться');
    } finally {
        fs.rmSync(sb, { recursive: true, force: true });
    }
});

test('--add: неизвестный файл — явно отчитан, на принятие не влияет', async () => {
    const bytes = Buffer.from('fake tarball @scope/pkg-1.0.0');
    const sb = seedSandbox([{ name: '@scope/pkg', version: '1.0.0', sri: sri512(bytes) }]);
    const src = path.join(sb, 'src');
    fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, flatName('@scope/pkg', '1.0.0')), bytes);
    fs.writeFileSync(path.join(src, 'stray-package-9.9.9.tgz'), Buffer.from('unknown'));
    try {
        const r = await runVendor(['--add', src], { NC_SUPPLY_ROOT: sb });
        assert.equal(r.code, 0, r.out + r.err);
        assert.match(r.out, /Добавлено: 1; неизвестных файлов: 1/);
        assert.match(r.err, /unknown: stray-package-9\.9\.9\.tgz/);
    } finally {
        fs.rmSync(sb, { recursive: true, force: true });
    }
});

test('--check (реальное состояние): 227 vendored / 227 всего, pending = 0 (plugin@1.14.48 принят 2026-11-06)', async () => {
    const r = await runVendor(['--check']);
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /Vendor-набор OK: 227 vendored \(верифицированы\), 227 всего\./);
    assert.doesNotMatch(r.out, /pending/);
});

test('--check: vendored без файла — стоп (exit 1) с явным сообщением', async () => {
    // Песочница с "vendored"-строкой, файла нет; cross-check с реальным supply-набором
    // тоже даст проблемы — проверяем именно failure-путь по отсутствию файла.
    const sb = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-vendor-sb-'));
    fs.mkdirSync(path.join(sb, 'vendor'), { recursive: true });
    fs.writeFileSync(
        path.join(sb, 'vendor/manifest.json'),
        JSON.stringify(
            {
                schemaVersion: 1,
                packages: [
                    {
                        name: '@opencode-ai/sdk',
                        version: '1.14.48',
                        path: 'supply/vendor/@opencode-ai/sdk-1.14.48.tgz',
                        integrity: ['sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='],
                        sha512: 'sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
                        status: 'vendored',
                    },
                ],
            },
            null,
            2,
        ) + '\n',
    );
    try {
        const r = await runVendor(['--check'], { NC_SUPPLY_ROOT: sb });
        assert.equal(r.code, 1, 'ожидался exit 1: ' + r.out + r.err);
        assert.match(r.out + r.err, /vendored, файла нет: supply\/vendor\/@opencode-ai\/sdk-1\.14\.48\.tgz/);
    } finally {
        fs.rmSync(sb, { recursive: true, force: true });
    }
});
