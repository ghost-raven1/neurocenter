/** Installer-verified identity of the bridge update lock owner. */
export interface IInstallerProof {
    root: string;
    pid: number;
    assertCurrent: () => Promise<void>;
}
/** Publication context of the explicit installer; parent identity is re-verified before every write. */
export interface IInstallMutexInfo {
    root: string;
    parent: string;
    parentIdentity: { dev: string; ino: string };
}
/** Explicit installer writers take the mutex or prove their caller owns the existing one. Maintenance never reuses it. */
export function withInstallMutex(
    info: IInstallMutexInfo,
    action: (proof: IInstallerProof) => Promise<unknown>,
    options?: { reuse?: boolean },
): Promise<{ acquired: boolean; value?: unknown }>;
/** Legacy dead-owner records are quarantined only by a verified explicit installer. No lock is unlinked by PID. */
export function recoverCleanupLock(request: {
    info: IInstallMutexInfo;
    root: string;
    filename: string;
    proof: IInstallerProof | null;
}): Promise<boolean>;
