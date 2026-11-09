/** Канон платформенных целей (AD-7): единственный список целей и явные маппинги имён. */
export type TRuntimeTarget =
    | 'darwin-arm64'
    | 'darwin-x64'
    | 'linux-arm64-glibc'
    | 'linux-x64-glibc'
    | 'linux-arm64-musl'
    | 'linux-x64-musl'
    | 'win32-arm64'
    | 'win32-x64';
export const TARGETS: readonly TRuntimeTarget[];
/** Явный маппинг цели bridge-пакета -> канонической цели. */
export const CANONICAL_TARGET_BY_PACKAGE: Readonly<Record<string, string>>;
/** win32-* к windows-*; цели без явного аналога отклоняются. */
export function toWindowsTarget(canonicalTarget: string): string;
/** Любое известное имя (канон, windows-*, package) к канону; неизвестное отклоняется. */
export function toCanonicalTarget(target: string): string;
/** Каноническая цель к цели bridge-пакета; win32-* package-аналога не имеют. */
export function toPackageTarget(canonicalTarget: string): string;
/** Явный маппинг канонической цели -> bridge-имени (unix→package-имя, win32→windows-имя). */
export const BRIDGE_TARGET_BY_CANONICAL: Readonly<Record<TRuntimeTarget, string>>;
/** Все 8 bridge-имён: значения явного маппинга. */
export const BRIDGE_TARGETS: readonly string[];
/** Любая каноническая цель к bridge-имени; цели без явного аналога отклоняются. */
export function toBridgeTarget(canonicalTarget: TRuntimeTarget): string;
