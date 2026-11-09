import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createRequire } from 'node:module';

/**
 * AD-13 (entry 2.11): ceiling-version handshake — graceful negotiation contractVersion.
 * Матрица плана: HANDSHAKE_OK / CLIENT_OLDER / CLIENT_NO_FIELD / FORMAT_OUT_OF_RANGE /
 * FORWARD_UNKNOWN / SEMVER_INVALID / GRACEFUL_NO_THROW (409 actionable, не 500).
 * Требует собранного dist catalog-service (npm run build в services/catalog-service).
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sharedRequire = createRequire(path.join(ROOT, 'services/shared/package.json')),
    catalogRequire = createRequire(path.join(ROOT, 'services/catalog-service/package.json')),
    { CONTRACT_VERSION, isContractVersion, compareContractVersions } = sharedRequire('./runtime/contract-version.cjs'),
    { assertContractBridge } = catalogRequire('./dist/devices/device-compatibility.js'),
    { workspaceReport } = catalogRequire('./dist/devices/device-report.js');

test('OQ3: строгий semver — только MAJOR.MINOR.PATCH, без pre-release/build и ведущих нулей', () => {
    for (const good of ['0.0.1', '1.2.2', '1.2.10', '9999.9999.9999']) {
        assert.equal(isContractVersion(good), true, good);
    }
    for (const bad of [
        'abc',
        '',
        '1',
        '1.2',
        '1.2.3.4',
        '1.2.3-rc.1',
        '1.2.3+build',
        '01.2.3',
        '1.02.3',
        '1.2.3\n',
        'v1.2.3',
        '1.2.10000',
        null,
        undefined,
        1,
        true,
        {},
        [],
    ]) {
        assert.equal(isContractVersion(bad), false, JSON.stringify(bad));
    }
    // Версия самого контракта — строгий semver (константа pinned-контракта).
    assert.equal(isContractVersion(CONTRACT_VERSION), true);
});

test('Сравнение версий — по численным компонентам, а не строкам', () => {
    assert.equal(compareContractVersions('1.2.2', '1.2.2'), 0);
    assert.ok(compareContractVersions('1.3.0', '1.4.0') < 0);
    assert.ok(compareContractVersions('1.4.0', '1.3.0') > 0);
    assert.ok(compareContractVersions('1.10.0', '1.9.9') > 0);
    assert.ok(compareContractVersions('2.0.0', '1.99.99') > 0);
    assert.ok(compareContractVersions('0.0.1', '0.0.2') < 0);
});

/** Полный report моста с capability-набором текущей версии. */
const report = (extra = {}) => ({
    platform: 'linux',
    arch: 'x64',
    runtimeVersion: '24.22.0',
    bridgeVersion: '0.9.28',
    buildId: 'build-qa',
    protocolVersion: 2,
    capabilities: ['durable-completions', 'managed-installations', 'package-v3', 'package-v4', 'package-v5'],
    ...extra,
});

test('HANDSHAKE_OK: asset.contractVersion <= client.maxContractVersion — установка проходит', () => {
    assertContractBridge(
        report({ maxContractVersion: '1.3.0', maxPackageFormat: 5 }),
        { contractVersion: '1.3.0', packageFormat: 5, bridgeProtocol: 2 },
    );
    assertContractBridge(
        report({ maxContractVersion: '1.4.0', maxPackageFormat: 5 }),
        { contractVersion: '1.3.0', packageFormat: 5, bridgeProtocol: 2 },
    );
});

test('CLIENT_OLDER: asset 1.4.0 > client 1.3.0 — 409 actionable с требуемой версией', () => {
    assert.throws(
        () =>
            assertContractBridge(report({ maxContractVersion: '1.3.0' }), {
                contractVersion: '1.4.0',
                packageFormat: 5,
                bridgeProtocol: 2,
            }),
        (error) => error.getStatus() === 409 && /1\.4\.0/.test(error.message),
    );
});

test('CLIENT_NO_FIELD: старый мост без maxContractVersion + пакет с contractVersion — 409 actionable', () => {
    assert.throws(
        () => assertContractBridge(report(), { contractVersion: '1.2.2', packageFormat: 5, bridgeProtocol: 2 }),
        (error) => error.getStatus() === 409 && typeof error.message === 'string' && error.message.length > 0,
    );
});

test('Формат/протокол вне capability-диапазона клиента — 409; в пределах — проходит', () => {
    // Потолок клиента 3, пакет v5.
    assert.throws(
        () => assertContractBridge(report({ maxPackageFormat: 3 }), { packageFormat: 5, bridgeProtocol: 2 }),
        (error) => error.getStatus() === 409,
    );
    // Ниже клиентского пола (v3) — тоже 409.
    assert.throws(
        () => assertContractBridge(report(), { packageFormat: 2, bridgeProtocol: 2 }),
        (error) => error.getStatus() === 409,
    );
    // Протокол выше capability клиента.
    assert.throws(
        () => assertContractBridge(report(), { packageFormat: 5, bridgeProtocol: 3 }),
        (error) => error.getStatus() === 409,
    );
    // В пределах диапазона — без ошибки (потолок по умолчанию 5 для старых report).
    assertContractBridge(report(), { packageFormat: 4, bridgeProtocol: 2 });
    assertContractBridge(report({ maxPackageFormat: 4 }), { packageFormat: 4, bridgeProtocol: 2 });
});

test('Некорректная contractVersion у ассета — сверка пропускается (fail-open, не 500)', () => {
    assertContractBridge(report(), { contractVersion: 'garbage', packageFormat: 5, bridgeProtocol: 2 });
    assertContractBridge(report(), { contractVersion: null, packageFormat: 5, bridgeProtocol: 2 });
    assertContractBridge(report(), { packageFormat: 5, bridgeProtocol: 2 });
});

test('FORWARD_UNKNOWN: неизвестные capability-поля report принимает и игнорирует', () => {
    const checked = workspaceReport(
        report({ maxContractVersion: '1.2.2', maxPackageFormat: 5, someFutureCapability: 'x', anotherFuture: 42 }),
    );
    assert.equal(checked.someFutureCapability, 'x');
    assert.equal(checked.anotherFuture, 42);
    // Handshake поверх такого report работает как usual: неизвестные поля не влияют на сверку.
    assertContractBridge(checked, { contractVersion: '1.2.2', packageFormat: 5, bridgeProtocol: 2 });
});

test('SEMVER_INVALID: некорректный maxContractVersion/maxPackageFormat в report — 400', () => {
    assert.throws(() => workspaceReport(report({ maxContractVersion: 'abc' })), (error) => error.getStatus() === 400);
    assert.throws(
        () => workspaceReport(report({ maxContractVersion: '1.2.3-rc.1' })),
        (error) => error.getStatus() === 400,
    );
    assert.throws(() => workspaceReport(report({ maxPackageFormat: 'five' })), (error) => error.getStatus() === 400);
    assert.throws(() => workspaceReport(report({ maxPackageFormat: 0 })), (error) => error.getStatus() === 400);
    // Корректные значения — report принимается.
    workspaceReport(report({ maxContractVersion: '1.2.2', maxPackageFormat: 5 }));
});

test('GRACEFUL_NO_THROW: любой кейс рассогласования — 409 с actionable-текстом, не 500 и не generic', () => {
    const mismatches = [
        [report({ maxContractVersion: '1.0.0' }), { contractVersion: '1.2.2', packageFormat: 5, bridgeProtocol: 2 }],
        [report(), { contractVersion: '1.2.2', packageFormat: 5, bridgeProtocol: 2 }],
        [report({ maxPackageFormat: 3 }), { packageFormat: 5, bridgeProtocol: 2 }],
        [report(), { packageFormat: 5, bridgeProtocol: 3 }],
    ];
    for (const [client, asset] of mismatches) {
        assert.throws(
            () => assertContractBridge(client, asset),
            (error) => {
                assert.equal(error.getStatus(), 409);
                assert.match(error.message, /Обновите локальный MCP/);
                return true;
            },
        );
    }
});
