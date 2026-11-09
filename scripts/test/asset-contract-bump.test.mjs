import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
    ARTIFACT_CEILING,
    BRIDGE_PROTOCOL_RANGE,
    CONTRACT_VERSION,
    PACKAGE_FORMAT_RANGE,
    assertIndexEvolution,
    loadRepository,
    serializeAsset,
    validateAsset,
    validateIndex,
} from '@neurocenter/asset-contract';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const SHA = 'ab'.repeat(32);
/** Old-style 1.2.1 descriptor: no contractVersion, no descriptor limits. */
const baseAsset = () => ({
    schemaVersion: 1,
    id: 'bump-fixture',
    kind: 'mcp',
    version: '1.0.0',
    source: { type: 'npm', name: 'bump-fixture', version: '1.0.0' },
    license: { spdx: 'MIT' },
    compatibility: { packageFormat: 5 },
    card: {
        name: 'Bump fixture',
        kind: 'mcp',
        description: 'Contract bump 1.2.2 fixture',
        revision: '1.0.0',
        files: [],
        config: { transport: 'stdio', args: [] },
    },
    delivery: {
        type: 'runtime-artifacts',
        artifacts: [
            {
                descriptor: {
                    target: 'linux-x64-glibc',
                    sha256: SHA,
                    compressedBytes: 1024,
                    unpackedBytes: 2048,
                    filesCount: 2,
                    entrypoint: 'index.mjs',
                },
            },
        ],
    },
});
const LIMITS = { compressedBytes: 1024, unpackedBytes: 2048, filesCount: 2, cacheBytes: 2 * 1024 ** 3 };
const descriptor = (asset) => asset.delivery.artifacts[0].descriptor;
const bridgeAsset = (protocol) => ({
    schemaVersion: 1,
    id: 'bump-bridge',
    kind: 'bridge',
    version: '1.0.0',
    source: { type: 'npm', name: 'bump-bridge', version: '1.0.0' },
    license: { spdx: 'MIT' },
    compatibility: protocol === undefined ? {} : { bridgeProtocol: protocol },
    card: { name: 'Bump bridge', description: 'Contract bump bridge fixture' },
    delivery: {
        type: 'bridge-release',
        release: {
            schemaVersion: 1,
            version: '1.0.0',
            buildId: 'c'.repeat(64),
            release: 'bridge-v1.0.0',
            artifacts: [
                {
                    file: 'neurocenter-asset-sync-linux-x64-1.0.0.tgz',
                    url: 'https://github.com/demo/repo/releases/download/bridge-v1.0.0/neurocenter-asset-sync-linux-x64-1.0.0.tgz',
                    metadata: {
                        version: '1.0.0',
                        target: 'linux-x64',
                        nodeVersion: '24.22.0',
                        buildId: 'c'.repeat(64),
                        ragSupported: false,
                        probeEngine: { version: '1.0.0', sha256: 'd'.repeat(64), file: 'bin/opencode-probe' },
                        sha256: 'e'.repeat(64),
                        bytes: 1024,
                    },
                },
            ],
        },
    },
});
const indexEntry = (status, overrides = {}) => ({
    id: 'bump-fixture',
    kind: 'mcp',
    version: '1.0.0',
    path: 'assets/bump-fixture/1.0.0/asset.json',
    sha256: SHA,
    current: true,
    ...(status !== undefined ? { status } : {}),
    ...overrides,
});
const indexWith = (...entries) => ({ schemaVersion: 1, assets: entries });

test('Contract 1.2.2 constants are the single pinned source (AD-12/AD-13)', () => {
    assert.deepEqual(ARTIFACT_CEILING, {
        compressedBytes: 1024 ** 3,
        unpackedBytes: 4 * 1024 ** 3,
        filesCount: 100000,
        cacheBytes: 8 * 1024 ** 3,
    });
    assert.equal(CONTRACT_VERSION, '1.2.2');
    assert.deepEqual(PACKAGE_FORMAT_RANGE, { min: 5, max: 5 });
    assert.deepEqual(BRIDGE_PROTOCOL_RANGE, { min: 2, max: 2 });
});

test('Descriptor limits within [1..ceiling] validate; the field stays optional at read (AD-2)', () => {
    const asset = baseAsset();
    descriptor(asset).limits = LIMITS;
    assert.deepEqual(validateAsset(asset).delivery.artifacts[0].descriptor.limits, LIMITS);
    assert.doesNotThrow(() => validateAsset(baseAsset()));
});

test('Produce mode makes descriptor limits mandatory (AD-2 fail-closed)', () => {
    const without = baseAsset();
    without.contractVersion = CONTRACT_VERSION;
    assert.throws(() => validateAsset(without, { mode: 'produce' }), /Runtime artifact limits required/);
    const withLimits = baseAsset();
    withLimits.contractVersion = CONTRACT_VERSION;
    descriptor(withLimits).limits = LIMITS;
    assert.doesNotThrow(() => validateAsset(withLimits, { mode: 'produce' }));
});

test('Descriptor limits outside [1..ceiling] are rejected', () => {
    const above = baseAsset();
    descriptor(above).limits = { ...LIMITS, compressedBytes: ARTIFACT_CEILING.compressedBytes + 1 };
    assert.throws(() => validateAsset(above), /Artifact limits compressedBytes exceed ceiling/);
    for (const key of Object.keys(ARTIFACT_CEILING)) {
        const invalid = baseAsset();
        descriptor(invalid).limits = { ...LIMITS, [key]: 0 };
        assert.throws(() => validateAsset(invalid), new RegExp(`Artifact limits ${key}: positive integer required`));
    }
    const stray = baseAsset();
    descriptor(stray).limits = { ...LIMITS, extraBytes: 1 };
    assert.throws(() => validateAsset(stray), /Artifact limits: unexpected structure or field/);
});

test('Declared artifact sizes validate against the ceiling, never against environment values (AD-2/AD-12)', (t) => {
    const names = [
        'NEUROCENTER_RUNTIME_MAX_COMPRESSED_BYTES',
        'NEUROCENTER_RUNTIME_MAX_UNPACKED_BYTES',
        'NEUROCENTER_RUNTIME_MAX_FILES',
    ];
    const before = names.map((name) => [name, process.env[name]]);
    t.after(() => {
        for (const [name, value] of before) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    });
    names.forEach((name) => (process.env[name] = '1024'));
    const halfGiB = baseAsset();
    descriptor(halfGiB).compressedBytes = 512 * 1024 ** 2;
    assert.doesNotThrow(() => validateAsset(halfGiB));
    const over = baseAsset();
    descriptor(over).compressedBytes = ARTIFACT_CEILING.compressedBytes + 1;
    assert.throws(() => validateAsset(over), /Runtime artifact exceeds compressedBytes ceiling/);
    const atCeiling = baseAsset();
    descriptor(atCeiling).compressedBytes = ARTIFACT_CEILING.compressedBytes;
    assert.doesNotThrow(() => validateAsset(atCeiling));
});

test('contractVersion: strict semver at read, exactly CONTRACT_VERSION at produce (AD-13)', () => {
    const current = baseAsset();
    current.contractVersion = CONTRACT_VERSION;
    assert.equal(validateAsset(current).contractVersion, CONTRACT_VERSION);
    for (const bad of ['v1.2.2', '1.2', '1.2.2-beta.01x ', '']) {
        const asset = baseAsset();
        asset.contractVersion = bad;
        assert.throws(() => validateAsset(asset), /Contract version/);
    }
    assert.throws(() => validateAsset(baseAsset(), { mode: 'produce' }), /Contract version 1.2\.2 required/);
    const stale = baseAsset();
    stale.contractVersion = '1.2.1';
    descriptor(stale).limits = LIMITS;
    assert.throws(() => validateAsset(stale, { mode: 'produce' }), /Contract version 1.2\.2 required/);
});

test('Index entry status: active/retired are valid, other values rejected (AD-16)', () => {
    assert.doesNotThrow(() => validateIndex(indexWith(indexEntry('active'))));
    assert.doesNotThrow(() => validateIndex(indexWith(indexEntry('retired'))));
    assert.doesNotThrow(() => validateIndex(indexWith(indexEntry(undefined))));
    assert.throws(() => validateIndex(indexWith(indexEntry('archived'))), /active or retired required/);
});

test('assertIndexEvolution: retired is irreversible, existing immutability checks preserved (AD-16)', () => {
    assert.throws(
        () => assertIndexEvolution(indexWith(indexEntry('retired')), indexWith(indexEntry('active'))),
        /Retired index version cannot return to active/,
    );
    for (const pair of [
        ['active', 'retired'],
        ['active', 'active'],
        ['retired', 'retired'],
        [undefined, 'active'],
        [undefined, 'retired'],
    ])
        assert.doesNotThrow(() => assertIndexEvolution(indexWith(indexEntry(pair[0])), indexWith(indexEntry(pair[1]))));
    const gone = indexWith();
    assert.throws(() => assertIndexEvolution(indexWith(indexEntry('retired')), gone), /cannot disappear/);
    const rebased = indexWith(indexEntry('retired', { sha256: 'cd'.repeat(32) }));
    assert.throws(() => assertIndexEvolution(indexWith(indexEntry('retired')), rebased), /bytes or kind changed/);
    const rekind = indexWith(indexEntry('retired', { kind: 'plugin' }));
    assert.throws(() => assertIndexEvolution(indexWith(indexEntry('retired')), rekind), /bytes or kind changed/);
});

test('packageFormat/bridgeProtocol validate against [min,max] ranges (AD-13)', () => {
    assert.doesNotThrow(() => validateAsset(baseAsset()));
    assert.doesNotThrow(() => validateAsset(bridgeAsset(2)));
    for (const value of [4, 6, 5.5, '5']) {
        const asset = baseAsset();
        asset.compatibility.packageFormat = value;
        assert.throws(() => validateAsset(asset), /Unsupported package format/);
    }
    for (const value of [1, 3, 2.5]) {
        assert.throws(() => validateAsset(bridgeAsset(value)), /Unsupported bridge protocol/);
    }
    const noFormat = baseAsset();
    noFormat.compatibility = {};
    assert.throws(() => validateAsset(noFormat), /Package format 5 required/);
    const noProtocol = bridgeAsset(undefined);
    assert.throws(() => validateAsset(noProtocol), /Bridge protocol 2 required/);
});

test('Existing published 1.2.1 bytes stay readable end to end (backward compatibility)', async (t) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'nc-contract-bump-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const bytes = serializeAsset(baseAsset());
    const directory = path.join(root, 'assets/bump-fixture/1.0.0');
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'asset.json'), bytes);
    await fs.writeFile(path.join(root, 'index.json'), JSON.stringify(indexWith(indexEntry(undefined, { sha256: sha(bytes) })), null, 2) + '\n');
    const loaded = await loadRepository(root);
    assert.equal(loaded.assets.length, 1);
    assert.equal(loaded.assets[0].asset.id, 'bump-fixture');
    assert.equal(loaded.assets[0].sha256, sha(bytes));
});
