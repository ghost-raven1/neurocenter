export interface IRagQuirk {
    id: string;
    content: string;
    quirkType?: string;
    tags: string[];
    confidence: number;
    lastObserved: string;
    sourceRef?: string;
}
export interface IQuirkEntry {
    quirk: IRagQuirk;
    recordSha256: string;
}
export interface IQuirkSource {
    kind: 'rag_quirk';
    trust: 'reported';
    quirk: IRagQuirk;
    recordSha256: string;
    fileSha256: string;
    assetId: string;
    assetKind: 'mcp' | 'plugin';
    version: number;
    manifest: string;
    configurationRevision: string | null;
}
export interface IQuirksSnapshot {
    fileSha256: string;
    records: IQuirkEntry[];
}
export interface IQuirksReceipt {
    schemaVersion: 1;
    status: 'complete' | 'partial';
    sourceCount: number;
    imported: number;
    skipped: number;
    remaining: number;
    fileSha256: string;
    safeRetry: true;
}
export interface ILearningQuirksLimits {
    bytes: number;
    totalBytes: number;
    records: number;
    recordBytes: number;
    contentBytes: number;
    importedExperiences: number;
    receiptBytes: number;
}
export const QUIRKS_LIMITS: Readonly<ILearningQuirksLimits>;
export const QUIRKS_SOURCE_SHA256: string;
export const QUIRKS_SOURCE_SHA256S: ReadonlyArray<string>;
export function supportsLearningQuirks(pkg: unknown): boolean;
export function normalizeQuirksLimits(value?: unknown): ILearningQuirksLimits;
export function parseQuirksJsonl(value: unknown, limits?: Partial<ILearningQuirksLimits>): IQuirksSnapshot;
export function preflightQuirkImport(
    snapshot: IQuirksSnapshot,
    target: { projectId: string; instanceId: string },
    existingIds: string[],
    maximum?: number,
): { newCount: number; existingCount: number };
export function normalizeQuirkSource(value: unknown): IQuirkSource;
export function quirkExperienceKey(
    projectId: string,
    instanceId: string,
    quirkId: string,
    recordSha256: string,
): string;
export function quirkReportedExperience(
    target: { projectId: string; instanceId: string },
    entry: IQuirkEntry,
    source: Omit<IQuirkSource, 'kind' | 'trust' | 'quirk' | 'recordSha256'>,
): import('./project-learning.cjs').TLearningObservedExperienceInput;
export function normalizeQuirksReceipt(value: unknown): IQuirksReceipt;
