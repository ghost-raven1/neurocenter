import fs from 'node:fs';

/** Проверка завершена только при согласованном отчёте Vitest, независимо от exit code. */
export function readVitestReport(filename) {
    let report;
    try { report = JSON.parse(fs.readFileSync(filename, 'utf8')); }
    catch (error) {
        throw new Error(error.code === 'ENOENT' ? 'Отчёт Vitest не создан.' : 'Отчёт Vitest не удалось прочитать как JSON.');
    }
    const counters = ['numPassedTests', 'numFailedTests', 'numPendingTests', 'numTodoTests', 'numTotalTests', 'numFailedTestSuites'];
    if (!report || typeof report !== 'object' || Array.isArray(report) || typeof report.success !== 'boolean'
        || counters.some(key => !Number.isSafeInteger(report[key]) || report[key] < 0)) {
        throw new Error('Отчёт Vitest содержит некорректные статусы или счётчики.');
    }
    const tests = {passed: report.numPassedTests, failed: report.numFailedTests, skipped: report.numPendingTests, todo: report.numTodoTests};
    if (Object.values(tests).reduce((sum, count) => sum + count, 0) !== report.numTotalTests) {
        throw new Error('Отчёт Vitest содержит несогласованную сумму тестов.');
    }
    const ok = report.success && tests.failed === 0 && report.numFailedTestSuites === 0;
    return {tests, ok, ...(!ok ? {reportError: 'Отчёт Vitest сообщает о неуспешной проверке.'} : {})};
}
