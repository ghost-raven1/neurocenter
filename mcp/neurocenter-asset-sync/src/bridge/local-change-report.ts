import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { localChangeReportPath } from './local-change-plan.js';
import { readLocalChangePlan } from './local-change-plan-storage.js';
import { hash } from './state.js';
import { readBoundedBytes } from './read-bounded.js';

export interface LocalChangeReportInput { projectId: string; bindingId: string; instanceId: string; planId: string; digest: string }

/** Отчёт открывается только на подключённом компьютере; браузер сервера не получает его содержимое. */
export async function openLocalChangeReport(input: LocalChangeReportInput): Promise<void> {
    const saved = await readLocalChangePlan(input.planId); const { summary } = saved;
    if (summary.projectId !== input.projectId || summary.bindingId !== input.bindingId || summary.instanceId !== input.instanceId || summary.digest !== input.digest
        || Date.now() > Date.parse(summary.expiresAt) || Date.parse(summary.checkedAt) > Date.now() + 5000) {
        throw new Error('Отчёт изменён, истёк или относится к другой привязке. Подготовьте сравнение заново.');
    }
    const file = await localChangeReportPath(input.planId);
    // Повторное чтение private plan внутри path helper не подменяет проверенный нами HTML.
    if (hash(await readBoundedBytes(file, 256 * 1048576)) !== saved.reportSha256) { throw new Error('Отчёт изменился перед открытием. Подготовьте сравнение заново.'); }
    const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
    await promisify(execFile)(command,[file],{timeout:8000,maxBuffer:16*1024,killSignal:'SIGKILL',windowsHide:true});
}
