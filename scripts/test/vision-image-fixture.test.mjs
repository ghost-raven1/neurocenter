import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { visionFixture } from '../vision/image-fixture.mjs';

/** Читает PNG независимо от encoder и проверяет контрольные суммы каждого chunk. */
function decode(png) {
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    const chunks = []; const compressed = []; let width; let height;
    for (let offset = 8; offset < png.length;) {
        const length = png.readUInt32BE(offset);
        const type = png.toString('ascii', offset + 4, offset + 8);
        const data = png.subarray(offset + 8, offset + 8 + length);
        let crc = 0xffffffff;
        for (const byte of png.subarray(offset + 4, offset + 8 + length)) {
            crc ^= byte;
            for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
        }
        assert.equal(png.readUInt32BE(offset + 8 + length), (crc ^ 0xffffffff) >>> 0);
        if (type === 'IHDR') {
            width = data.readUInt32BE(0); height = data.readUInt32BE(4);
            assert.deepEqual([...data.subarray(8)], [8, 2, 0, 0, 0]);
        }
        if (type === 'IDAT') compressed.push(data);
        chunks.push(type); offset += length + 12;
    }
    assert.deepEqual(chunks, ['IHDR', 'IDAT', 'IEND']);
    const raw = inflateSync(Buffer.concat(compressed));
    assert.equal(raw.length, (width * 3 + 1) * height);
    for (let y = 0; y < height; y++) assert.equal(raw[y * (width * 3 + 1)], 0);
    return { width, height, pixel: (x, y) => [...raw.subarray(y * (width * 3 + 1) + 1 + x * 3, y * (width * 3 + 1) + 4 + x * 3)] };
}

test('PNG имеет валидные CRC и данные RGB: чёрные цифры, красный квадрат и белый фон', () => {
    const image = decode(visionFixture({ number: '42', color: 'red' }));
    assert.equal(image.width, 384); assert.equal(image.height, 256);
    assert.deepEqual(image.pixel(0, 0), [255, 255, 255]);
    assert.deepEqual(image.pixel(168, 24), [0, 0, 0]);
    assert.deepEqual(image.pixel(150, 150), [255, 0, 0]);
    assert.deepEqual(image.pixel(240, 240), [255, 255, 255]);
});

test('Контрпример меняет и цифры, и цвет; повтор воспроизводит те же байты', () => {
    const first = visionFixture({ number: '42', color: 'red' });
    const second = visionFixture({ number: '17', color: 'blue' });
    assert.deepEqual(first, visionFixture({ number: '42', color: 'red' }));
    assert.notDeepEqual(first, second);
    assert.deepEqual(decode(second).pixel(150, 150), [0, 0, 255]);
    assert.notDeepEqual(first, visionFixture({ number: '17', color: 'red' }));
});

test('Все десять цифр рисуются разными bitmap без текстовых PNG-метаданных', () => {
    const hashes = new Set();
    for (let digit = 0; digit <= 9; digit++) {
        const png = visionFixture({ number: String(digit), color: 'green' });
        assert.deepEqual(decode(png).pixel(150, 150), [0, 160, 0]);
        hashes.add(png.toString('base64'));
    }
    assert.equal(hashes.size, 10);
});

test('Некорректные подписи и неизвестные цвета отклоняются до генерации', () => {
    for (const number of ['', '12345', '-1', '4 2', '<script>', 42, null]) assert.throws(() => visionFixture({ number }), /цифр/);
    for (const color of ['purple', '__proto__', null]) assert.throws(() => visionFixture({ color }), /Цвет PNG/);
});
