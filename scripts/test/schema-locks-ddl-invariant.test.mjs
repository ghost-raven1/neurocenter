import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(path.join(root, 'services/catalog-service/package.json'));
require('ts-node').register({
    project: path.join(root, 'services/catalog-service/tsconfig.json'),
    transpileOnly: true,
});
const { featureFlagsMigrationManifest } = require(
    path.join(root, 'services/feature-flags-service/src/database/migrations.ts'),
);

/** Regression-гейт: checksum замороженной v1-миграции в ledger'ах существующих БД (AD-D1). */
const FROZEN_V1_CHECKSUM = '7324275e1a3ca4dd3299f9288b48b8dd8a7a1cdca2ec82d4647a2f062751014d';

test('Замороженная v1-миграция feature-flags не изменилась (checksum в manifest)', () => {
    assert.equal(featureFlagsMigrationManifest()[0].checksum, FROZEN_V1_CHECKSUM);
});

test('feature-flags-schema.ts не содержит DDL security_events (единый источник — каталог)', () => {
    const source = fs.readFileSync(
        path.join(root, 'services/feature-flags-service/src/database/feature-flags-schema.ts'),
        'utf8',
    );
    assert.ok(!source.includes('security_events'), 'DDL security_events должен существовать только в каталоге');
});

test('dev-init не создаёт ghost-БД skills', () => {
    const init = fs.readFileSync(path.join(root, 'services/rag-sync-service/init/00-create-databases.sql'), 'utf8');
    assert.ok(!/CREATE\s+DATABASE\s+skills/i.test(init), 'ghost-БД skills не должна создаваться');
});

test('feature-flags использует собственный миграционный лок, а не лок каталога', () => {
    const source = fs.readFileSync(
        path.join(root, 'services/feature-flags-service/src/database/migrations.ts'),
        'utf8',
    );
    assert.ok(!source.includes('neurocenter:catalog:migrations'), 'feature-flags не должен делить лок каталога');
    assert.ok(
        source.includes('neurocenter:feature-flags:migrations'),
        'feature-flags должен использовать собственный лок',
    );
});
