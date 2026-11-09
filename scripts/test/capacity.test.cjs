'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
    createCapacityGuard,
    CapacityError,
    resources,
    reserveBytes,
    validateSnapshot,
    getCapacityStatus,
} = require('../../services/shared/capacity.cjs');
const { collectCapacity } = require('../../services/shared/capacity-collector.cjs');
const time = 1700000000000;
const sample = (free = reserveBytes + 1024, observedAt = time) => ({
    schemaVersion: 1,
    observedAt,
    resources: Object.fromEntries(
        resources.map((key) => [
            key,
            { available: true, filesystem: '1', totalBytes: reserveBytes * 4, freeBytes: free },
        ]),
    ),
});
const low = (error) => error instanceof CapacityError && error.statusCode === 507 && error.code === 'CAPACITY_LOW';
const unavailable = (error) =>
    error instanceof CapacityError && error.statusCode === 503 && error.code === 'CAPACITY_UNAVAILABLE';

test('Недостаток физического места отклоняет операцию до записи', async () => {
    const reserve = createCapacityGuard({
        required: () => true,
        snapshot: () => sample(reserveBytes + 10),
        now: () => time,
    });
    let writes = 0;
    await assert.rejects(async () => {
        const release = await reserve({ resource: 'postgres', bytes: 11 });
        try {
            writes++;
        } finally {
            release();
        }
    }, low);
    assert.equal(writes, 0);
});
test('Отсутствующий, просроченный и будущий замеры закрывают тяжёлую запись', async () => {
    for (const snapshot of [
        () => {
            throw new Error('missing');
        },
        () => sample(undefined, time - 90001),
        () => sample(undefined, time + 5001),
        () => ({ ...sample(), resources: {} }),
    ]) {
        const reserve = createCapacityGuard({ required: () => true, snapshot, now: () => time });
        await assert.rejects(reserve({ resource: 'postgres', bytes: 1 }), unavailable);
    }
});
test('Конкурентные операции и разные ресурсы одного физического диска делят резерв', async () => {
    const reserve = createCapacityGuard({
        required: () => true,
        snapshot: () => sample(reserveBytes + 100),
        now: () => time,
    });
    const release = await reserve({ resource: 'postgres', bytes: 60 });
    await assert.rejects(reserve({ resource: 'skills', bytes: 50 }), low);
    release();
    release();
    await assert.rejects(reserve({ resource: 'postgres', bytes: 50 }), low);
});
test('Завершённая запись остаётся учтённой до нового физического замера', async () => {
    let snapshot = sample(reserveBytes + 100);
    const reserve = createCapacityGuard({ required: () => true, snapshot: () => snapshot, now: () => time + 1 });
    (await reserve({ resource: 'postgres', bytes: 60 }))();
    await assert.rejects(reserve({ resource: 'postgres', bytes: 50 }), low);
    snapshot = sample(reserveBytes + 100, time + 1);
    (await reserve({ resource: 'postgres', bytes: 50 }))();
});
test('Новый замер не освобождает резерв незавершённой операции', async () => {
    let snapshot = sample(reserveBytes + 100);
    const reserve = createCapacityGuard({ required: () => true, snapshot: () => snapshot, now: () => time + 1 });
    const release = await reserve({ resource: 'postgres', bytes: 60 });
    snapshot = sample(reserveBytes + 100, time + 1);
    await assert.rejects(reserve({ resource: 'skills', bytes: 50 }), low);
    release();
});
test('Запись после нового замера остаётся учтённой и после завершения старой операции', async () => {
    let snapshot = sample(reserveBytes + 100);
    const reserve = createCapacityGuard({ required: () => true, snapshot: () => snapshot, now: () => time + 2 });
    const release = await reserve({ resource: 'postgres', bytes: 60 });
    snapshot = sample(reserveBytes + 100, time + 1);
    // Новый замер сделан до записи 60 байт; параллельный запрос переводит guard на его epoch.
    (await reserve({ resource: 'skills', bytes: 1 }))();
    release();
    await assert.rejects(reserve({ resource: 'postgres', bytes: 50 }), low);
    snapshot = sample(reserveBytes + 100, time + 2);
    (await reserve({ resource: 'postgres', bytes: 50 }))();
});
test('Недоступный WAL блокирует запись, а не превращается в нулевой здоровый том', async () => {
    const snapshot = sample();
    snapshot.resources.wal = { available: false };
    assert.throws(() => validateSnapshot(snapshot, time));
    await assert.rejects(
        createCapacityGuard({ required: () => true, snapshot: () => snapshot, now: () => time })({
            resource: 'postgres',
            bytes: 1,
        }),
        unavailable,
    );
});
test('Локальный том сверяется с реальным файловым устройством и собственным statfs', async () => {
    const options = {
        required: () => true,
        snapshot: () => sample(),
        now: () => time,
        statfs: async () => ({ bavail: 2n * BigInt(reserveBytes), bsize: 1n }),
        stat: async () => ({ dev: 2 }),
    };
    await assert.rejects(
        createCapacityGuard(options)({ resource: 'skills', bytes: 1, path: '/controlled-volume' }),
        unavailable,
    );
    options.stat = async () => ({ dev: 1 });
    options.statfs = async () => ({ bavail: BigInt(reserveBytes), bsize: 1n });
    await assert.rejects(
        createCapacityGuard(options)({ resource: 'skills', bytes: 1, path: '/controlled-volume' }),
        low,
    );
});
test('Повреждённые оценки и неизвестные ресурсы не проходят admission', async () => {
    const reserve = createCapacityGuard({ required: () => false });
    for (const bytes of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        await assert.rejects(reserve({ resource: 'postgres', bytes }), TypeError);
    }
    await assert.rejects(reserve({ resource: 'arbitrary-path', bytes: 1 }), TypeError);
});
test('Сборщик измеряет настоящие тома и WAL и отклоняет внешний симлинк', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nc-capacity-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    for (const resource of resources.filter((key) => key !== 'wal')) {
        await fs.mkdir(path.join(root, resource));
    }
    const wal = path.join(root, 'postgres/pg_wal');
    await fs.mkdir(wal);
    await fs.writeFile(path.join(wal, '000000010000000000000001'), 'wal');
    await fs.writeFile(path.join(root, 'model-weights', 'weights.bin'), Buffer.alloc(1024 * 1024));
    const snapshot = await collectCapacity({ root, now: () => time });
    assert.equal(snapshot.schemaVersion, 2);
    assert.deepEqual(Object.keys(snapshot.resources).sort(), [...resources].sort());
    validateSnapshot(snapshot, time);
    assert.equal(snapshot.resources.wal.walBytes, 3);
    assert.equal(snapshot.resources.wal.filesystem, snapshot.resources.postgres.filesystem);
    // 7-й ресурс: фактические байты volume, а не константа — данные на томе видны через statfs.
    const weights = snapshot.resources['model-weights'];
    assert.equal(weights.available, true);
    assert.ok(weights.totalBytes > 0);
    assert.ok(weights.totalBytes - weights.freeBytes >= 1024 * 1024);
    await fs.rm(wal, { recursive: true });
    await fs.symlink(path.join(root, 'projects'), wal);
    const unavailableSnapshot = await collectCapacity({ root, now: () => time });
    assert.equal(unavailableSnapshot.resources.wal.available, false);
    assert.throws(() => validateSnapshot(unavailableSnapshot, time));
});

const legacySample = (observedAt = time) => ({
    schemaVersion: 1,
    observedAt,
    resources: Object.fromEntries(
        resources
            .filter((key) => key !== 'model-weights')
            .map((key) => [
                key,
                { available: true, filesystem: '1', totalBytes: reserveBytes * 4, freeBytes: reserveBytes + 1024 },
            ]),
    ),
});

test('Legacy-снапшот (schemaVersion 1, 6 ресурсов) валиден: model-weights = undefined, а не 0', () => {
    const legacy = legacySample();
    assert.doesNotThrow(() => validateSnapshot(legacy, time));
    assert.equal(legacy.resources['model-weights'], undefined);
});

test('Снапшот schemaVersion 2 обязан нести все 7 ресурсов, включая model-weights', () => {
    const legacy = legacySample();
    const current = {
        ...legacy,
        schemaVersion: 2,
        resources: {
            ...legacy.resources,
            'model-weights': {
                available: true,
                filesystem: '1',
                totalBytes: reserveBytes * 4,
                freeBytes: reserveBytes + 1024,
            },
        },
    };
    assert.doesNotThrow(() => validateSnapshot(current, time));
    assert.throws(() => validateSnapshot({ ...legacy, schemaVersion: 2 }, time));
    assert.throws(() =>
        validateSnapshot(
            { ...current, resources: { ...current.resources, 'model-weights': { available: false } } },
            time,
        ),
    );
});

test('Legacy-снапшот без старого ресурса по-прежнему невалиден', () => {
    const broken = legacySample();
    delete broken.resources.backups;
    assert.throws(() => validateSnapshot(broken, time));
});

test('Несмонтированный model-weights у сборщика — явная ошибка, а не тихий пустой ресурс', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nc-capacity-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    for (const resource of resources.filter((key) => key !== 'wal' && key !== 'model-weights')) {
        await fs.mkdir(path.join(root, resource));
    }
    await fs.mkdir(path.join(root, 'postgres/pg_wal'));
    await assert.rejects(collectCapacity({ root, now: () => time }), /model-weights/);
});

test('Резерв против model-weights на legacy-снапшоте закрывает операцию, а не падает как TypeError', async () => {
    const reserve = createCapacityGuard({ required: () => true, snapshot: () => legacySample(), now: () => time });
    await assert.rejects(reserve({ resource: 'model-weights', bytes: 1 }), unavailable);
});

test('Неизвестный физический статус не выдаёт нулевые размеры здорового диска', () => {
    const missing = () => {
        throw new Error('snapshot unavailable');
    };
    assert.deepEqual(getCapacityStatus({ required: () => true, snapshot: missing }), {
        available: false,
        reason: 'CAPACITY_UNAVAILABLE',
        maxAgeSeconds: 90,
    });
    assert.deepEqual(getCapacityStatus({ required: () => false, snapshot: missing }), {
        available: false,
        reason: 'CAPACITY_NOT_CONFIGURED',
    });
});
