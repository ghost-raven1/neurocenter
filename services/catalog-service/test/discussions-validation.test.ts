import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { discussionAttachmentIds, discussionBody, discussionObject, discussionTarget } from '../src/discussions/discussions.validation';
import { discussionFileContent, discussionFileName, DiscussionsStorage } from '../src/discussions/discussions.storage';

describe('Discussion input and bounded binary upload boundary', () => {
    it.each([['catalog', 'mcp:ai-plug-example'], ['catalog', 'skill:common/start'], ['help', 'connect-bridge']])('accepts a stable target %s %s', (type, id) => { expect(discussionTarget(type, id)).toEqual({ type, id }); });
    it.each([['unknown', 'x'], ['help', '../secret'], ['help', 'same%2fother'], ['catalog', 'arbitrary:x'], ['catalog', 'mcp:'], ['catalog', 'mcp:x:y']])('rejects an unknown or ambiguous target %s %s', (type, id) => { expect(() => discussionTarget(type, id)).toThrow(); });
    it('rejects unknown fields, empty text, repeated files and UTF-8 byte overflow', () => {
        expect(() => discussionObject({ body: 'ok', privileged: true }, ['body'])).toThrow();
        expect(() => discussionBody('  ')).toThrow(); expect(() => discussionBody('я'.repeat(8001))).toThrow();
        expect(discussionBody(' hello ')).toBe('hello');
        expect(() => discussionAttachmentIds(Array(6).fill('00000000-0000-0000-0000-000000000001'))).toThrow();
        expect(() => discussionAttachmentIds(Array(2).fill('00000000-0000-0000-0000-000000000001'))).toThrow();
    });
    it('keeps UTF-8 filenames and rejects paths, active markup and mismatched bytes', () => {
        expect(discussionFileName(encodeURIComponent('ошибка лога.md'))).toEqual({ name: 'ошибка лога.md', mediaType: 'text/markdown' });
        for (const name of ['../secret.txt', 'bad\\secret.txt', 'script.html', 'script.svg', 'bad\r\n.txt']) expect(() => discussionFileName(encodeURIComponent(name))).toThrow();
        expect(() => discussionFileContent(Buffer.from('<html>script</html>'), 'image/png')).toThrow();
        expect(() => discussionFileContent(Buffer.from('%PDF-1.7\n'), 'application/pdf')).not.toThrow();
        expect(() => discussionFileContent(Buffer.from([0xff]), 'text/plain')).toThrow();
    });
    it('consumes binary bytes without JSON/base64 and rejects incomplete or excessive streams', async () => {
        const storage = new DiscussionsStorage();
        expect(await storage.consume(Readable.from([Buffer.from('he'), Buffer.from('llo')]), '5')).toEqual(Buffer.from('hello'));
        await expect(storage.consume(Readable.from([Buffer.from('short')]), '6')).rejects.toMatchObject({ status: 400 });
        await expect(storage.consume(Readable.from([Buffer.from('toolong')]), '4')).rejects.toMatchObject({ status: 400 });
        await expect(storage.consume(Readable.from([Buffer.from('x')]), String(10 * 1024 ** 2 + 1))).rejects.toMatchObject({ status: 400 });
    });
});
