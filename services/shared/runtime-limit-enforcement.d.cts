import type { IRuntimeLimitPolicy } from './runtime-limits.cjs';
export interface IRuntimeLimitEnforcementPoint {
    /** Enforcement-файл (относительно корня репо), где политика применяется до операции. */
    file: string;
    /** Функция/класс — точка применения политики (admission). */
    symbol: string;
    /** Подстрока-доказательство применения политики в enforcement-файле. */
    marker: string;
    /** Тест, покрывающий enforcement-точку (относительно корня репо). */
    test: string;
}
export interface ICeilingLiteralAllowlistEntry {
    file: string;
    line: string;
    reason: string;
}
export const ENFORCEMENT_POINTS: Readonly<Record<string, Readonly<IRuntimeLimitEnforcementPoint>>>;
export const ENFORCEMENT_EXEMPTIONS: Readonly<Record<string, string>>;
export const DEGENERATE_DEFERRED: Readonly<Record<string, string>>;
export const CEILING_LITERAL_ALLOWLIST: ReadonlyArray<Readonly<ICeilingLiteralAllowlistEntry>>;
export const RUNTIME_LIMIT_CEILINGS: Readonly<IRuntimeLimitPolicy>;
export const DEFAULT_RUNTIME_LIMIT_POLICY: Readonly<IRuntimeLimitPolicy>;
