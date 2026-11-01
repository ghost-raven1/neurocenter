export interface IMaintenanceWindow {
    days: number[];
    start: string;
    end: string;
}
export interface IMaintenancePolicy {
    enabled: boolean;
    timeZone: string;
    schedule: { days: number[]; time: string };
    windows: IMaintenanceWindow[];
    maxPauseMinutes: number;
    localCopies: number;
    externalRetentionDays: number;
    rpoMinutes: number;
    rtoMinutes: number;
}
export const defaultPolicy: IMaintenancePolicy;
export function validateMaintenancePolicy(value: unknown): IMaintenancePolicy;
export function nextMaintenanceRun(
    policy: IMaintenancePolicy,
    after?: Date | string,
    excludedSlot?: string,
): { at: string; slot: string } | null;
export function dueMaintenanceRun(policy: IMaintenancePolicy, now?: Date): { at: string; slot: string } | null;
export function inWindow(windows: IMaintenanceWindow[], day: number, minute: number, duration?: number): boolean;
