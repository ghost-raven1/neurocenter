import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applicationServices } from '../production/compose-client.mjs';
import { schemaServices } from '../production/schema-migrations.mjs';
import {
    buildReleaseManifest,
    validateReleaseManifest,
    verifyReleaseManifest,
} from '../production/release-manifest.mjs';
import {
    loadEnvironmentModel,
    loadProductionCompose,
    structuralDrift,
} from '../production/environment-model.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const image = (letter) => 'sha256:' + letter.repeat(64);
const PROMETHEUS = image('8');
const ALERTMANAGER = image('9');
const serviceLetters = ['a', 'b', 'c', 'd', 'e', 'f', '0'];
const serviceImages = () =>
    Object.fromEntries(applicationServices.map((service, index) => [service, image(serviceLetters[index])]));
const migrationRows = (service) =>
    service === 'rag-sync-service'
        ? [{ scope: 'data', version: 'project-generations-1', name: 'Поколения проектов', checksum: 'c'.repeat(64) }]
        : [
              { version: 0, name: 'Полная исходная схема', checksum: 'b'.repeat(64) },
              { version: 1, name: 'История установки', checksum: 'c'.repeat(64) },
          ];
const migrationManifests = () => Object.fromEntries(schemaServices.map((service) => [service, migrationRows(service)]));
const vendorContract = () => ({
    package: '@neurocenter/asset-contract',
    version: '1.2.1',
    commit: 'e'.repeat(40),
    sha256sums: { 'README.md': '9'.repeat(64), 'SOURCE.json': '8'.repeat(64) },
});
const supply = () => ({
    runtime: [],
    opencode: [],
    installers: [{ name: 'install.sh', sha256: 'b'.repeat(64) }],
    vendorContract: vendorContract(),
});
const actuals = () => ({
    commit: 'a'.repeat(40),
    release: 'fixture-1',
    images: serviceImages(),
    postgresImage: image('d'),
    nodeExporterImage: image('e'),
    monitoringImages: { prometheus: PROMETHEUS, alertmanager: ALERTMANAGER },
    supply: supply(),
    migrations: migrationManifests(),
});
function manifest(overrides = {}) {
    return buildReleaseManifest({ ...actuals(), ...overrides });
}

test('release manifest: monitoringImages — digest-pin для prometheus и alertmanager обязателен', () => {
    const valid = manifest();
    assert.equal(validateReleaseManifest(valid), valid);
    // Точная форма ключей: ровно prometheus + alertmanager, оба imagePattern (sha256 64 hex).
    assert.deepEqual(Object.keys(valid.monitoringImages).sort(), ['alertmanager', 'prometheus']);
    for (const name of ['prometheus', 'alertmanager']) {
        assert.match(valid.monitoringImages[name], /^sha256:[a-f0-9]{64}$/, name);
    }
    const cases = [
        ['поле отсутствует', (value) => delete value.monitoringImages],
        ['prometheus отсутствует', (value) => delete value.monitoringImages.prometheus],
        ['alertmanager отсутствует', (value) => delete value.monitoringImages.alertmanager],
        ['лишний ключ', (value) => (value.monitoringImages.extra = PROMETHEUS)],
        ['лишний ключ', (value) => (value.monitoringImages.node_exporter = ALERTMANAGER)],
        ['prometheus не digest', (value) => (value.monitoringImages.prometheus = 'prom/prometheus:v3.0.0')],
        ['alertmanager не digest', (value) => (value.monitoringImages.alertmanager = 'prom/alertmanager:v0.32.1')],
        ['не объект', (value) => (value.monitoringImages = [PROMETHEUS, ALERTMANAGER])],
    ];
    for (const [label, mutate] of cases) {
        const broken = structuredClone(valid);
        mutate(broken);
        assert.throws(() => validateReleaseManifest(broken), /манифест/, label);
    }
});

test('release manifest: verify ловит расхождение monitoringImages с фактическим состоянием', () => {
    const valid = manifest();
    assert.deepEqual(verifyReleaseManifest(valid, actuals()), []);
    const drift = actuals();
    drift.monitoringImages = { prometheus: image('a'), alertmanager: ALERTMANAGER };
    const mismatches = verifyReleaseManifest(valid, drift);
    assert.equal(mismatches.length, 1);
    assert.ok(mismatches[0].startsWith('monitoringImages.prometheus'));
    const missing = actuals();
    delete missing.monitoringImages;
    const missingMismatches = verifyReleaseManifest(valid, missing);
    assert.equal(missingMismatches.length, 2);
    assert.ok(missingMismatches.some((line) => line.startsWith('monitoringImages.prometheus')));
    assert.ok(missingMismatches.some((line) => line.startsWith('monitoringImages.alertmanager')));
});

test('production compose: prometheus и alertmanager в backend-сети, без публичных портов, модель согласована', async () => {
    const model = await loadEnvironmentModel(root);
    const services = await loadProductionCompose(root, model);
    // Модель и compose согласованы для всего стека (включая оба мониторинг-сервиса).
    assert.deepEqual(structuralDrift(model, services), []);
    // prometheus — backend, без портов наружу, scrape-токен из секрета.
    assert.deepEqual(services.prometheus.networks, ['backend']);
    assert.deepEqual(services.prometheus.ports, []);
    assert.equal(services.prometheus.networkMode, null);
    assert.deepEqual(services.prometheus.secrets, ['metrics_token']);
    assert.equal(services.prometheus.image, 'prom/prometheus:v3.0.0@sha256:3b9b2a15d376334da8c286d995777d3b9315aa666d2311170ada6059a517b74f');
    // alertmanager — backend, без портов наружу (9093 только internal).
    assert.deepEqual(services.alertmanager.networks, ['backend']);
    assert.deepEqual(services.alertmanager.ports, []);
    assert.equal(services.alertmanager.networkMode, null);
    assert.deepEqual(services.alertmanager.secrets, []);
    assert.equal(services.alertmanager.image, 'prom/alertmanager:v0.32.1@sha256:06a1e7960b1a68794ef943744082dc361dd352fd07ed3319ab6de3f929f38ad2');
    // Мониторинг не объявляет env: metrics_token — строго compose-секрет (/run/secrets/metrics_token).
    assert.deepEqual(services.prometheus.env, {});
    assert.deepEqual(services.alertmanager.env, {});
    // Согласованность модели: те же сети, порты, секреты и digest-pin.
    assert.deepEqual(model.services.prometheus.networks, ['backend']);
    assert.deepEqual(model.services.prometheus.ports, []);
    assert.deepEqual(model.services.prometheus.secrets, ['metrics_token']);
    assert.deepEqual(model.services.alertmanager.networks, ['backend']);
    assert.deepEqual(model.services.alertmanager.ports, []);
    assert.deepEqual(model.services.alertmanager.secrets, []);
});
