'use strict';
const { gzipSync } = require('node:zlib');
const { createHash } = require('node:crypto');
const { CEILING } = require('../../services/shared/runtime-artifacts.cjs');
/** Разбивка длинных путей на USTAR name (100) + prefix (155), иначе честный отказ. */
function nameAndPrefix(path) {
    const bytes = Buffer.byteLength(path);
    if (bytes <= 100) return { name: path, prefix: '' };
    let cut = -1;
    for (let index = path.lastIndexOf('/'); index >= 0; index = path.lastIndexOf('/', index - 1)) {
        if (Buffer.byteLength(path.slice(index + 1)) <= 100) {
            cut = index;
            break;
        }
    }
    if (cut < 0 || Buffer.byteLength(path.slice(0, cut)) > 155)
        throw new Error('Путь фикстуры превышает ограничение USTAR (name 100 / prefix 155 байт).');
    return { name: path.slice(cut + 1), prefix: path.slice(0, cut) };
}
/** Маленький настоящий USTAR для вредоносных путей и оборванных загрузок. */
function artifactFixture(
    files = [{ path: 'runtime/server.mjs', content: 'export default {};', mode: 0o644 }],
    target = 'darwin-arm64',
) {
    const blocks = [];
    const entrypoint = files.find((file) => (file.type ?? '0') === '0')?.path || 'runtime/server.mjs';
    for (const file of files) {
        const bytes = Buffer.from(file.content || '');
        const mode = (file.mode ?? 0o644) & 0o111 ? 0o755 : (file.mode ?? 0o644);
        const { name, prefix } = nameAndPrefix(file.path);
        const header = Buffer.alloc(512);
        header.write(name, 0, 100, 'utf8');
        if (prefix) header.write(prefix, 345, 155, 'utf8');
        header.write(mode.toString(8).padStart(7, '0') + '\0', 100, 'ascii');
        header.write('0000000\0', 108, 'ascii');
        header.write('0000000\0', 116, 'ascii');
        header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124, 'ascii');
        header.write('00000000000\0', 136, 'ascii');
        header.fill(32, 148, 156);
        header[156] = (file.type ?? '0').charCodeAt(0);
        if (file.link) header.write(file.link, 157, 100, 'utf8');
        header.write('ustar\0', 257, 'ascii');
        header.write('00', 263, 'ascii');
        let sum = 0;
        for (const byte of header) sum += byte;
        header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
        blocks.push(header, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512));
    }
    blocks.push(Buffer.alloc(1024));
    const archive = gzipSync(Buffer.concat(blocks));
    const regular = files.filter((file) => (file.type ?? '0') === '0');
    const entrypointFile = regular.find((file) => file.path === entrypoint);
    const unpackedBytes = regular.reduce((sum, file) => sum + Buffer.byteLength(file.content || ''), 0);
    // AD-2: limits — обязательное поле дескриптора; фикстура несёт точную политику артефакта,
    // а кэш-бюджет — до ceiling (клиент применяет min(descriptor.limits, ceiling)).
    const limits = {
        compressedBytes: archive.length,
        unpackedBytes,
        filesCount: regular.length,
        cacheBytes: CEILING.cacheBytes,
    };
    return {
        archive,
        descriptor: {
            target,
            sha256: createHash('sha256').update(archive).digest('hex'),
            compressedBytes: archive.length,
            unpackedBytes,
            filesCount: regular.length,
            entrypoint,
            limits,
            ...(entrypointFile && (entrypointFile.mode ?? 0o644) & 0o111 ? { executable: true } : {}),
        },
    };
}
module.exports = { artifactFixture };
