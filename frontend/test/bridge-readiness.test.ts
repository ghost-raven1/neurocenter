import { describe, expect, it } from 'vitest';
import { bridgeOperationBlocker, installationBlocker } from '../src/features/McpBridge/readiness';
import type { IBridgeDevice } from '../src/features/McpBridge/api';

const device: IBridgeDevice = { id: 'fixture', name: 'Компьютер', role: 'Разработчик', fingerprint: '', online: true, lastSeen: null,
    report: { protocolVersion: 2, capabilities: ['durable-completions', 'managed-installations', 'install-set-v1'] } };
describe('Проверка компьютера до установки', () => {
    it('Разрешает очередь поддерживаемому компьютеру, даже когда он временно офлайн', () => {
        expect(installationBlocker(device)).toBe(''); expect(installationBlocker({ ...device, online: false })).toBe('');
    });
    it('Показывает понятную причину при истёкшем подключении', () => {
        expect(installationBlocker({ ...device, requiresReconnect: true })).toContain('истекло');
    });
    it('Роль в шапке не повышает ограниченную роль подключения', () => {
        expect(installationBlocker({ ...device, role: 'Наблюдатель' })).toContain('Роль');
    });
    it.each([{}, { protocolVersion: 1 }, { protocolVersion: 2, capabilities: [] }])('Старый или неполный протокол предлагает обновление: %j', report => {
        expect(installationBlocker({ ...device, report })).toContain('Обновите');
    });
    it('MCP 0.4 продолжает выбор папки и синхронизацию, но предлагает обновление для установки и удаления', () => {
        const old = {...device,report:{...device.report,bridgeVersion:'0.4.1',capabilities:['durable-completions','managed-installations','package-v4']}};
        expect(bridgeOperationBlocker(old)).toBe('');
        expect(installationBlocker(old)).toContain('Обновите мост');
        expect(installationBlocker(old)).toContain('установки и удаления');
    });
    it('Принимает возможность install-set-v1, а не доверяет строке версии', () => {
        expect(installationBlocker({...device,report:{...device.report,bridgeVersion:'0.5.0',capabilities:['durable-completions','managed-installations']}})).toContain('Обновите');
        expect(installationBlocker({...device,report:{...device.report,bridgeVersion:'0.6.0'}})).toBe('');
    });
    it('Общие операции сохраняют проверки роли, подключения и протокола', () => {
        expect(bridgeOperationBlocker()).toContain('Выберите');
        expect(bridgeOperationBlocker({...device,requiresReconnect:true})).toContain('истекло');
        expect(bridgeOperationBlocker({...device,role:'Наблюдатель'})).toContain('Роль');
        expect(bridgeOperationBlocker({...device,report:{protocolVersion:1}})).toContain('Обновите');
    });
});
