import { beforeEach, vi } from 'vitest';

const files = vi.hoisted(() => new Map<string, string>());
vi.mock('node:fs/promises', () => ({
    default: {
        realpath: vi.fn(async (file: string) => file),
        open: vi.fn(async (file: string) => {
            const text = files.get(file);
            if (text === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
            const bytes = Buffer.from(text);
            return {
                stat: async () => ({ isFile: () => true, nlink: 1, size: bytes.length, mtimeMs: 1, ctimeMs: 1 }),
                read: async (buffer: Buffer) => {
                    bytes.copy(buffer);
                    return { bytesRead: bytes.length };
                },
                close: async () => undefined,
            };
        }),
        writeFile: vi.fn(async (file: string, value: string) => {
            files.set(file, value);
        }),
        rename: vi.fn(async (from: string, to: string) => {
            files.set(to, files.get(from)!);
            files.delete(from);
        }),
        rm: vi.fn(async (file: string) => {
            files.delete(file);
        }),
    },
}));
export const file = '/owned/catalog-rebuild.json';
export const request = {
    schemaVersion: 1,
    requestId: '12345678-1234-4234-8234-123456789012',
    sourceRevision: 'a'.repeat(64),
    requestedAt: '2026-11-01T00:00:00.000Z',
};
export const jobId = '22345678-1234-4234-8234-123456789012';
export const writeStatus = (value: unknown) => files.set(file + '.status.json', JSON.stringify(value));
beforeEach(() => {
    files.clear();
    files.set(file, JSON.stringify(request));
});
