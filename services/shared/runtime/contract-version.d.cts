/**
 * AD-13: версия asset-контракта — re-export из pinned `@neurocenter/asset-contract`
 * (единственный источник, как ceiling-константы AD-12); из окружения не читается.
 */
export const CONTRACT_VERSION: string;
/** Строгий semver `MAJOR.MINOR.PATCH`: без pre-release/build, без ведущих нулей, компоненты до 9999 (OQ3). */
export function isContractVersion(value: unknown): boolean;
/** Численное сравнение двух проверенных версий: отрицательное — ниже, ноль — равны, положительное — выше. */
export function compareContractVersions(left: string, right: string): number;
