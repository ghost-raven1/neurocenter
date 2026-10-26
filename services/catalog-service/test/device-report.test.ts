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

    const binding = { projectId:'project', folderName:'folder', valid:true, identityStatus:'verified',
        bindingId:'a'.repeat(64), instanceId:'11111111-1111-4111-8111-111111111111' };
    const dataSize = { scope:'opencode', bytes:123, measuredAt:'2026-10-26T10:00:00.000Z' };

    it.each([0,123,null])('Сохраняет полный локальный замер %s вместе с точной привязкой',bytes=>{
        const measurement={...dataSize,bytes,...(bytes===null?{error:'unavailable'}:{})};
        const report={bindings:[{...binding,dataSize:measurement}]};
        expect(workspaceReport(report)).toEqual(report);
    });
    it.each([
        null,[],{}, {...dataSize,scope:'project'}, {...dataSize,bytes:-1}, {...dataSize,bytes:1.1},
        {...dataSize,bytes:NaN}, {...dataSize,bytes:Number.MAX_SAFE_INTEGER+1}, {...dataSize,bytes:'123'},
        {...dataSize,measuredAt:'invalid'}, {...dataSize,measuredAt:123}, {...dataSize,error:'unavailable'},
        {...dataSize,bytes:null}, {...dataSize,bytes:null,error:'private/path'},
    ].map(value=>[value]))('Не принимает повреждённый или неполный локальный размер: %j',measurement=>{
        expect(()=>workspaceReport({bindings:[{...binding,dataSize:measurement}]})).toThrow('Некорректный отчёт');
    });
    it.each([
        {valid:false},{identityStatus:'legacy'},{identityStatus:undefined},{bindingId:undefined},{instanceId:undefined},
    ])('Не принимает байты без проверенного экземпляра: %j',change=>{
        expect(()=>workspaceReport({bindings:[{...binding,...change,dataSize}]})).toThrow('Некорректный отчёт');
    });
});
