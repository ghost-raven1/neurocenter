import { BadRequestException, ConflictException } from '@nestjs/common';

/** Старый клиент не получает задания с неподдерживаемым подтверждением результата. */
export function assertManagedBridge(report: Record<string, unknown> | undefined): void {
    if (!report || report.protocolVersion !== 2 || !Array.isArray(report.capabilities)
        || !report.capabilities.includes('durable-completions') || !report.capabilities.includes('managed-installations')) {
        throw new ConflictException('Обновите локальный MCP на странице «Начало работы»: текущий мост не поддерживает надёжное подтверждение действий.');
    }
}

/** Бинарные ресурсы требуют клиента, который сохраняет исходные байты и умеет их откатывать. */
export function assertPackageBridge(report: Record<string, unknown>, pkg: { schemaVersion?: number }): void {
    if (pkg.schemaVersion === 5 && (!Array.isArray(report.capabilities) || !report.capabilities.includes('package-v5'))) {
        throw new ConflictException('Обновите локальный MCP до версии 0.9 или новее: пакет содержит готовый комплект или локальную настройку.');
    }
    if (pkg.schemaVersion === 4 && (!Array.isArray(report.capabilities) || !report.capabilities.includes('package-v4'))) {
        throw new ConflictException('Обновите локальный MCP на странице «Начало работы»: пакет использует независимый от языка ОС формат.');
    }
    if (pkg.schemaVersion === 3 && (!Array.isArray(report.capabilities) || !report.capabilities.includes('package-v3'))) {
        throw new ConflictException('Обновите локальный MCP на странице «Начало работы»: пакет содержит бинарные ресурсы нового формата.');
    }
}

/** Даже одиночная установка меняет реестр владельцев; старые клиенты не должны обходить его. */
export function assertInstallationSetBridge(report: Record<string, unknown>): void {
    if (!Array.isArray(report.capabilities) || !report.capabilities.includes('install-set-v1')) {
        throw new ConflictException('Обновите локальный MCP: установка и удаление требуют безопасного реестра зависимостей версии 0.5 или новее.');
    }
}

/** Проверка файлов требует отдельного контракта, независимо от установки и RAG. */
export function assertInstallationInspectionBridge(report: Record<string, unknown>): void {
    if (!Array.isArray(report.capabilities) || !report.capabilities.includes('installation-inspection-v1')) {
        throw new ConflictException('Обновите локальный MCP до версии 0.6 или новее для проверки файлов установленных инструментов.');
    }
}

/** Отпечаток выбранной строки не позволяет смене папки перенаправить действие. */
export function assertExpectedBinding(bindingId: string, expected: unknown, required = false): void {
    if (expected === undefined && !required) { return; }
    if (expected === undefined) { throw new ConflictException('Перечитайте установки и выберите привязку папки перед действием.'); }
    if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected)) { throw new BadRequestException('Некорректный отпечаток выбранной папки.'); }
    if (expected !== bindingId) { throw new ConflictException('Папка проекта изменилась. Перечитайте установки и повторите действие для выбранной привязки.'); }
}

export function managedBinding(report: Record<string, unknown>, projectId?: string): string {
    const binding = Array.isArray(report.bindings) ? report.bindings.find((item: { projectId?: string }) => item?.projectId === projectId) : undefined;
    if (!binding || binding.valid === false || typeof binding.bindingId !== 'string' || !/^[a-f0-9]{64}$/.test(binding.bindingId)) {
        throw new ConflictException('Сначала свяжите доступную локальную папку выбранного проекта на странице «Проекты».');
    }
    return binding.bindingId;
}
