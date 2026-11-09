import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    TARGETS,
    BRIDGE_TARGET_BY_CANONICAL,
    BRIDGE_TARGETS,
    toBridgeTarget,
    toCanonicalTarget,
    toPackageTarget,
    toWindowsTarget,
} = require('../runtime/targets.cjs') as typeof import('../runtime/targets.cjs');

/** Ожидание bridge-имён: явный объект (unix → package-имя, win32 → windows-имя). */
const BRIDGE_EXPECTED = {
    'darwin-arm64': 'darwin-arm64',
    'darwin-x64': 'darwin-x64',
    'linux-arm64-glibc': 'linux-arm64',
    'linux-x64-glibc': 'linux-x64',
    'linux-arm64-musl': 'linux-arm64-musl',
    'linux-x64-musl': 'linux-x64-musl',
    'win32-arm64': 'windows-arm64',
    'win32-x64': 'windows-x64',
} as const;

test('toBridgeTarget: все 8 канонических целей имеют явный bridge-аналог', () => {
    for (const [canonicalTarget, expected] of Object.entries(BRIDGE_EXPECTED)) {
        assert.equal(toBridgeTarget(canonicalTarget), expected);
    }
    assert.deepEqual(BRIDGE_TARGET_BY_CANONICAL, { ...BRIDGE_EXPECTED });
    assert.equal(Object.keys(BRIDGE_TARGET_BY_CANONICAL).length, 8);
});

test('BRIDGE_TARGETS — 8 уникальных замороженных bridge-имён', () => {
    assert.ok(Object.isFrozen(BRIDGE_TARGETS));
    assert.equal(BRIDGE_TARGETS.length, 8);
    assert.equal(new Set(BRIDGE_TARGETS).size, 8);
});

test('toBridgeTarget отклоняет цели без явного bridge-аналога', () => {
    for (const value of ['linux-x64', 'windows-x64', 'linux-x64-gnu', '', 'Linux-x64-glibc', 42, null, undefined]) {
        assert.throws(() => toBridgeTarget(value as unknown as string), /не имеет явного bridge-аналога/);
    }
});

test('Round-trip: toCanonicalTarget(toBridgeTarget(target)) === target для всех канонов', () => {
    for (const target of TARGETS) {
        assert.equal(toCanonicalTarget(toBridgeTarget(target)), target);
    }
});

test('unix-цели совпадают с package-аналогами, win32-цели — с windows-аналогами', () => {
    for (const target of TARGETS) {
        if (target.startsWith('win32-')) {
            assert.equal(toBridgeTarget(target), toWindowsTarget(target));
        } else {
            assert.equal(toBridgeTarget(target), toPackageTarget(target));
        }
    }
});
