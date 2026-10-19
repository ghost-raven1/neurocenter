import { spawnSync } from 'node:child_process';
import path from 'node:path';

/** Ошибка необязательной поставки не останавливает приложение с сохранённым каталогом. */
export function syncStartupCatalog({ node, root, environment, output }, run = spawnSync) {
    const result = run(node, [path.join(root, 'services/catalog-service/dist/builtin-catalog/sync.cli.js'),
        path.join(root, 'scripts/catalog-plugins/catalog-release.json'), '--skip-conflicts'], {
        cwd: root, env: environment, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024,
    });
    const retry = () => output.info('Повторить обновление каталога', 'npm run tools:sync');
    if (result.error || result.status !== 0) {
        output.warning('Встроенный каталог не обновлён — запуск приложения продолжится');
        const reason = String(result.stderr || result.error?.message || `Код завершения: ${result.status}`)
            .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim().slice(-2000);
        output.info('Причина', reason);
        retry();
        return { ok: false };
    }
    let report;
    try { report = JSON.parse(result.stdout); } catch { /* Неподтверждённый ответ не объявляем успешным. */ }
    if (report?.ok !== true || !Array.isArray(report.tools)
        || report.partial && (!Array.isArray(report.conflicts) || !report.conflicts.length
            || report.conflicts.some(conflict => !conflict || typeof conflict.name !== 'string' || typeof conflict.reason !== 'string'))) {
        output.warning('Не удалось подтвердить обновление каталога — запуск приложения продолжится');
        retry();
        return { ok: false };
    }
    if (report.partial) {
        output.warning(`Каталог обновлён частично: конфликтующих инструментов — ${report.conflicts.length}`);
        for (const conflict of report.conflicts) {
            output.info(String(conflict.name).slice(0, 128), String(conflict.reason).slice(0, 1000));
        }
        retry();
    } else { output.success('Каталог инструментов синхронизирован'); }
    return { ok: true, partial: !!report.partial };
}
