import type { IBundledSourcePlan } from '../interfaces';
export interface IBundledSourceCardProps {
    plan: IBundledSourcePlan;
    blocked: boolean;
    locked: boolean;
    onPrepare: (plan: IBundledSourcePlan) => void;
    onImportArchive: () => void;
}
