import { BadRequestException } from '@nestjs/common';

/** Проверяет известные поля JSONB: отчёт компьютера не может сломать страницу подключения. */
export function workspaceReport(value: unknown): Record<string, unknown> {
    const fail = () => { throw new BadRequestException('Некорректный отчёт локального MCP. Обновите клиент и повторите подключение.'); };
    if (!value || typeof value !== 'object' || Array.isArray(value)) { return fail(); }
    const report = value as Record<string, unknown>;
    if (Buffer.byteLength(JSON.stringify(report)) > 400000) { return fail(); }
    for (const field of ['platform', 'arch', 'runtimeVersion', 'bridgeVersion', 'buildId', 'root', 'rootError', 'ragError']) {
        if (report[field] != null && (typeof report[field] !== 'string' || (report[field] as string).length > 32768)) { return fail(); }
    }
    for (const field of ['folders', 'capabilities']) {
        if (report[field] !== undefined && (!Array.isArray(report[field]) || report[field].length > 1000 || report[field].some((item: unknown) => typeof item !== 'string' || item.length > 1024))) { return fail(); }
    }
    for (const field of ['protocolVersion', 'previousDeviceCompletions']) {
        if (report[field] !== undefined && (!Number.isSafeInteger(report[field]) || Number(report[field]) < 0)) { return fail(); }
    }
    if (report.ragSupported !== undefined && typeof report.ragSupported !== 'boolean') { return fail(); }
    if(report.runtimeArtifactTarget!==undefined&&!['darwin-arm64','darwin-x64','linux-arm64-glibc','linux-x64-glibc','linux-arm64-musl','linux-x64-musl','win32-arm64','win32-x64'].includes(String(report.runtimeArtifactTarget)))return fail();
    if (report.bindings !== undefined) {
        if (!Array.isArray(report.bindings) || report.bindings.length > 1000) { return fail(); }
        for (const raw of report.bindings) {
            const item = raw as Record<string, unknown> | null;
            if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.projectId !== 'string' || typeof item.folderName !== 'string'
                || (item.valid !== undefined && typeof item.valid !== 'boolean') || (item.error !== undefined && typeof item.error !== 'string')
                || (item.bindingId !== undefined && (typeof item.bindingId !== 'string' || !/^[a-f0-9]{64}$/.test(item.bindingId)))) { return fail(); }
            if (item.instanceId !== undefined && (typeof item.instanceId !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(item.instanceId))) { return fail(); }
            if (item.previousBindingId !== undefined && (typeof item.previousBindingId !== 'string' || !/^[a-f0-9]{64}$/.test(item.previousBindingId))) { return fail(); }
            if (item.identityStatus !== undefined && !['verified','legacy','copied','changed','unavailable'].includes(String(item.identityStatus))) { return fail(); }
        }
    }
    return report;
}
