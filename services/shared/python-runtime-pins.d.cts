import type { IRemoteRuntimeAsset, TRuntimeTarget } from './tool-runtime-source.cjs';
export const PYTHON_VERSION: '3.12.15';
export const UV_VERSION: '0.13.4';
export const PBS_RELEASE: '20261020';
export function pythonRuntimeAssets(): Partial<Record<TRuntimeTarget, IRemoteRuntimeAsset>>;
export function pythonBuildPins(target: string): {
    python: IRemoteRuntimeAsset & { bytes: number };
    uv: IRemoteRuntimeAsset & { bytes: number };
    platform: string;
};
