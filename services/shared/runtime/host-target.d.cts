import type { TRuntimeTarget } from './targets.cjs';
export interface IHostTargetOptions {
    platform?: string;
    arch?: string;
    /** Runtime report (process.report.getReport() или инъекция); process.report — только при его отсутствии. */
    report?: unknown;
    /** 'unknown' (по умолчанию): неизвестная libc даёт base-unknown; 'throw': неподдерживаемая цель отклоняется. */
    mode?: 'unknown' | 'throw';
}
/**
 * Единая детекция цели хоста (AD-7): Linux различает glibc и musl, неизвестная платформа не подменяется похожей.
 */
export function getHostTarget(options: IHostTargetOptions & { mode: 'throw' }): TRuntimeTarget;
export function getHostTarget(options?: IHostTargetOptions): string;
