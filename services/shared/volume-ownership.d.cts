/**
 * AD-OP-6 (OQ-2): fail-closed проверка владельцев writable-томов при старте сервиса
 * (production-only; см. volume-ownership.cjs).
 */
export function assertServiceVolumes(service: string, roots: Array<string | undefined>): void;
