/** Канон платформенных целей (AD-7): единственный список целей и явные маппинги имён. */
export const TARGETS: readonly string[];
/** Явный маппинг win32-* -> windows-*. */
export const WINDOWS_TARGET_BY_CANONICAL: Readonly<Record<string, string>>;
/** Явный маппинг windows-* -> win32-*. */
export const CANONICAL_TARGET_BY_WINDOWS: Readonly<Record<string, string>>;
/** Явный маппинг канонической цели -> цели bridge-пакета; win32-* package-аналога не имеют. */
export const PACKAGE_TARGET_BY_CANONICAL: Readonly<Record<string, string>>;
/** Явный маппинг цели bridge-пакета -> канонической цели. */
export const CANONICAL_TARGET_BY_PACKAGE: Readonly<Record<string, string>>;
/** win32-* к windows-*; цели без явного аналога отклоняются. */
export function toWindowsTarget(canonicalTarget: string): string;
/** Любое известное имя (канон, windows-*, package) к канону; неизвестное отклоняется. */
export function toCanonicalTarget(target: string): string;
/** Каноническая цель к цели bridge-пакета; win32-* package-аналога не имеют. */
export function toPackageTarget(canonicalTarget: string): string;
