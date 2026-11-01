export type TRuntimeTarget =
    | 'darwin-arm64'
    | 'darwin-x64'
    | 'linux-arm64-glibc'
    | 'linux-arm64-musl'
    | 'linux-x64-glibc'
    | 'linux-x64-musl'
    | 'win32-arm64'
    | 'win32-x64';
export type TRuntimeAdapter = 'python' | 'java' | 'dotnet' | 'go' | 'rust' | 'native';
export interface IRemoteRuntimeAsset {
    url: string;
    sha256: string;
    format: 'tar.gz' | 'zip' | 'file';
    entrypoint: string;
    executables?: string[];
}
export interface ILocalRuntimeAsset {
    directory: string;
    entrypoint: string;
    executables?: string[];
}
import type { IPythonSourcePlan } from './python-source-plan.cjs';
export interface IRuntimeSource {
    type: 'runtime';
    adapter: TRuntimeAdapter;
    assets: Partial<
        Record<
            TRuntimeTarget,
            { app: IRemoteRuntimeAsset | ILocalRuntimeAsset; runtime?: IRemoteRuntimeAsset | ILocalRuntimeAsset }
        >
    >;
    python?: IPythonSourcePlan;
}
export function validateRuntimeSource(value: unknown): IRuntimeSource;
export function runtimeSourceTargets(value: unknown): TRuntimeTarget[];
export function runtimeAdapterLabel(adapter: TRuntimeAdapter): string;
export function isPublicRuntimeAddress(value: string): boolean;
