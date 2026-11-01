import type { IRuntimeSource, TRuntimeTarget } from './tool-runtime-source.cjs';
export interface IRepositoryRelease {
    tag: string;
    asset?: string;
    id?: number;
    assetId?: number;
    sha256?: string;
}
export interface IReleaseAsset {
    id: number;
    name: string;
    bytes: number;
    url: string;
    format: 'tar.gz' | 'zip' | 'file';
    sha256?: string;
}
export interface IReleaseInspection {
    sha256: string;
    entrypoint: string;
    candidates: string[];
    name?: string;
    runtimeSource?: IRuntimeSource;
    warnings?: string[];
    executableChoices?: Array<{
        entrypoint: string;
        runtimeEntrypoint?: string;
        adapter: string;
        targets: TRuntimeTarget[];
    }>;
}
export type TReleaseInspector = (asset: IReleaseAsset, entrypoint?: string) => Promise<IReleaseInspection>;
export function validateReleaseInput(value: unknown): IRepositoryRelease;
