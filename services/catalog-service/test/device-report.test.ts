import { describe, expect, it } from 'vitest';
import { workspaceReport } from '../src/devices/device-report';

describe('Недоверенный отчёт локального компьютера', () => {
    it.each([null, [], { folders: {} }, { capabilities: 'all' }, { root: {} }, { bindings: [null] }, { bindings: [{ projectId: 'p', folderName: 'folder', bindingId: '../bad' }] }, { ragSupported: 'yes' }])('Отклоняет структуру, которая сломала бы интерфейс: %j', input => {
        expect(() => workspaceReport(input)).toThrow('Некорректный отчёт');
    });
    it('Поддерживает прежний отчёт и новый контракт без потери полей', () => {
        expect(workspaceReport({ platform: 'darwin', bindings: [{ projectId: 'p', folderName: 'проект' }] })).toMatchObject({ platform: 'darwin' });
        expect(workspaceReport({ protocolVersion: 2, capabilities: ['managed-installations'], ragSupported: false })).toMatchObject({ ragSupported: false });
    });
});
