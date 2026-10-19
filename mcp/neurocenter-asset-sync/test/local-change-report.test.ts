import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openLocalChangeReport, type LocalChangeReportInput } from '../src/bridge/local-change-report.js';
import { prepareLocalChange, localChangeReportPath } from '../src/bridge/local-change-plan.js';
import * as plans from '../src/bridge/local-change-plan.js';
import { localChangeDigest, localChangeFiles, localChangeHtml, readLocalChangePlan } from '../src/bridge/local-change-plan-storage.js';
import { stateDir, hash } from '../src/bridge/state.js';
import { assetBase } from '../src/bridge/installation-receipt.js';
import { install } from '../src/bridge/installer.js';
import { packageFixture, workspaceFixture } from './bridge-fixture.js';

vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), execFile: vi.fn((...args: unknown[]) => {
    const callback = args.at(-1) as (error: null, stdout: string, stderr: string) => void; callback(null, '', '');
}) }));

describe('Открытие именно подтверждённого локального сравнения', () => {
    let fixture: Awaited<ReturnType<typeof workspaceFixture>>;
    let input: LocalChangeReportInput;
    beforeEach(async () => {
        fixture = await workspaceFixture(); vi.mocked(execFile).mockClear(); const pkg = packageFixture();
        await install('test-project', pkg, async () => undefined, async () => undefined);
        await fs.writeFile(path.join(fixture.root, assetBase(pkg), 'SKILL.md'), 'моя правка');
        const summary = await prepareLocalChange('test-project', pkg, undefined, async () => undefined);
        input = { projectId: summary.projectId, bindingId: summary.bindingId, instanceId: summary.instanceId, planId: summary.planId, digest: summary.digest };
    });
    afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await fs.rm(fixture.temporary, { recursive: true, force: true }); });
    it('Передаёт OS opener только проверенный локальный HTML и не открывает настоящий интерфейс в тесте', async () => {
        const report = await localChangeReportPath(input.planId); await openLocalChangeReport(input);
        expect(execFile).toHaveBeenCalledOnce(); expect(vi.mocked(execFile).mock.calls[0]![1]).toEqual([report]);
    });
    it.each(['projectId', 'bindingId', 'instanceId', 'digest'] as const)('Подмена %s останавливает открытие до OS вызова', async field => {
        await expect(openLocalChangeReport({ ...input, [field]: 'подмена' })).rejects.toThrow('другой привязке'); expect(execFile).not.toHaveBeenCalled();
    });
    it('Просроченный queued отчёт не открывается', async () => {
        const saved = await readLocalChangePlan(input.planId); vi.spyOn(Date, 'now').mockReturnValue(Date.parse(saved.summary.expiresAt) + 1);
        await expect(openLocalChangeReport(input)).rejects.toThrow('истёк'); expect(execFile).not.toHaveBeenCalled();
    });
    it('Самосогласованная подмена private JSON и HTML не выдаётся за прежний digest очереди', async () => {
        const saved = await readLocalChangePlan(input.planId); saved.changes[0]!.after = Buffer.from('другой diff').toString('base64');
        saved.summary.files = localChangeFiles(saved.changes); const html = localChangeHtml(saved); saved.reportSha256 = hash(html); saved.summary.digest = localChangeDigest(saved);
        await fs.writeFile(path.join(stateDir(), 'local-change-plans', input.planId + '.html'), html);
        await fs.writeFile(path.join(stateDir(), 'local-change-plans', input.planId + '.json'), JSON.stringify(saved));
        await expect(localChangeReportPath(input.planId)).resolves.toContain('.html');
        await expect(openLocalChangeReport(input)).rejects.toThrow('Отчёт изменён'); expect(execFile).not.toHaveBeenCalled();
    });
    it('Подмена отчёта между проверкой digest и получением path обнаруживается по исходному HTML SHA', async () => {
        const original = plans.localChangeReportPath;
        vi.spyOn(plans, 'localChangeReportPath').mockImplementationOnce(async id => {
            const saved = await readLocalChangePlan(id); saved.changes[0]!.after = Buffer.from('подмена между чтениями').toString('base64');
            saved.summary.files = localChangeFiles(saved.changes); const html = localChangeHtml(saved); saved.reportSha256 = hash(html); saved.summary.digest = localChangeDigest(saved);
            await fs.writeFile(path.join(stateDir(), 'local-change-plans', id + '.html'), html);
            await fs.writeFile(path.join(stateDir(), 'local-change-plans', id + '.json'), JSON.stringify(saved));
            return original(id);
        });
        await expect(openLocalChangeReport(input)).rejects.toThrow('изменился перед открытием'); expect(execFile).not.toHaveBeenCalled();
    });
});
