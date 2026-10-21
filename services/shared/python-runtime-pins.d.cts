import type {RemoteRuntimeAsset,RuntimeTarget} from './tool-runtime-source.cjs';
export const PYTHON_VERSION: '3.12.15';
export const UV_VERSION: '0.13.4';
export const PBS_RELEASE: '20261020';
export function pythonRuntimeAssets(): Partial<Record<RuntimeTarget,RemoteRuntimeAsset>>;
export function pythonBuildPins(target:string): {python:RemoteRuntimeAsset & {bytes:number};uv:RemoteRuntimeAsset & {bytes:number};platform:string};
