import fs from 'node:fs';
import path from 'node:path';
import contract from '../../../../services/shared/project-learning-quirks.cjs';

/** The distinct code prevents an upstream fallback from replacing corrupt central state. */
export function validateManagedQuirksJsonl(raw) {
    try { return contract.parseQuirksJsonl(raw); }
    catch (error) { throw Object.assign(error, { code: 'RAG_QUIRKS_INVALID' }); }
}

/** Validate every record before upstream reads, repairs or reconciles any part of the journal. */
export function readManagedQuirksJsonl(file) {
    let handle;
    try { handle = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
    catch (error) { if (error.code === 'ENOENT') return ''; throw new Error('Кварки RAG недоступны. Исходные данные сохранены; проверьте файл и повторите.'); }
    try {
        const before = fs.fstatSync(handle);
        if (!before.isFile() || before.nlink !== 1 || before.size > contract.QUIRKS_LIMITS.bytes) throw new Error('Кварки RAG повреждены или превышают лимит. Исходные данные сохранены.');
        const bytes = Buffer.alloc(before.size + 1);
        let length = 0, read;
        while (length < bytes.length && (read = fs.readSync(handle, bytes, length, bytes.length - length, null)) > 0) length += read;
        const after = fs.fstatSync(handle), named = fs.lstatSync(file);
        if (length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== named.ino || before.dev !== named.dev || named.isSymbolicLink()) throw new Error('Кварки RAG изменились во время проверки. Повторите запуск.');
        const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
        validateManagedQuirksJsonl(raw);
        return raw;
    } finally { fs.closeSync(handle); }
}

/** A missing journal is allowed; a corrupt existing journal never reaches native startup. */
export function assertManagedQuirksSource(storePath) { readManagedQuirksJsonl(path.join(storePath, 'quirks.jsonl')); }

/** Reject an invalid candidate or exhausted journal budget before upstream embeds or changes its index. */
export function assertManagedQuirksWrite(storePath, quirk) {
    const raw = readManagedQuirksJsonl(path.join(storePath, 'quirks.jsonl'));
    const records = raw.trim() ? raw.trimEnd().split('\n').map(line => JSON.parse(line)) : [];
    const position = records.findIndex(record => record.id === quirk.id);
    if (position < 0) records.push(quirk); else records[position] = quirk;
    validateManagedQuirksJsonl(records.map(record => JSON.stringify(record)).join('\n') + '\n');
}
