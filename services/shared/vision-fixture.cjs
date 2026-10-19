'use strict';
const {deflateSync} = require('node:zlib');

const WIDTH = 384;
const HEIGHT = 256;
const DIGITS = [
    ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
    ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
    ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
    ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
    ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
    ['11111', '10000', '10000', '11110', '00001', '00001', '11110'],
    ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
    ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
    ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
    ['01110', '10001', '10001', '01111', '00001', '00010', '11100'],
];
const COLORS = { red: [255, 0, 0], blue: [0, 0, 255], green: [0, 160, 0] };
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, initial) => {
    let value = initial;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    return value >>> 0;
});

/** Собирает PNG chunk с CRC, без текстовых метаданных и внешнего растеризатора. */
function chunk(type, data) {
    const name = Buffer.from(type);
    const content = Buffer.concat([name, data]);
    let crc = 0xffffffff;
    for (const byte of content) crc = CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8);
    const result = Buffer.alloc(data.length + 12);
    result.writeUInt32BE(data.length); content.copy(result, 4);
    result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
    return result;
}

/** Создаёт собственный PNG: крупные чёрные цифры сверху, одноцветный квадрат снизу. */
function visionFixture({ number = '42', color = 'red' } = {}) {
    if (typeof number !== 'string' || !/^\d{1,4}$/.test(number)) throw new TypeError('Для PNG нужны от одной до четырёх цифр.');
    if (!Object.hasOwn(COLORS, color)) throw new TypeError('Цвет PNG: red, blue или green.');
    const stride = WIDTH * 3 + 1;
    const pixels = Buffer.alloc(stride * HEIGHT, 255);
    for (let y = 0; y < HEIGHT; y++) pixels[y * stride] = 0;
    const rectangle = (x, y, width, height, rgb) => {
        for (let row = y; row < y + height; row++) {
            for (let column = x; column < x + width; column++) {
                const offset = row * stride + 1 + column * 3;
                pixels[offset] = rgb[0]; pixels[offset + 1] = rgb[1]; pixels[offset + 2] = rgb[2];
            }
        }
    };
    const scale = 12;
    const gap = 12;
    const textWidth = number.length * 5 * scale + (number.length - 1) * gap;
    const left = (WIDTH - textWidth) / 2;
    for (let index = 0; index < number.length; index++) {
        const digit = DIGITS[Number(number[index])];
        for (let row = 0; row < 7; row++) for (let column = 0; column < 5; column++) {
            if (digit[row][column] === '1') rectangle(left + index * (5 * scale + gap) + column * scale, 20 + row * scale, scale, scale, [0, 0, 0]);
        }
    }
    rectangle(144, 144, 96, 96, COLORS[color]);
    const header = Buffer.alloc(13);
    header.writeUInt32BE(WIDTH, 0); header.writeUInt32BE(HEIGHT, 4);
    header[8] = 8; header[9] = 2;
    return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

module.exports = {visionFixture};
