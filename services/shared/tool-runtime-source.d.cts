export type RuntimeTarget = 'darwin-arm64' | 'darwin-x64' | 'linux-arm64-glibc' | 'linux-arm64-musl' | 'linux-x64-glibc' | 'linux-x64-musl' | 'win32-arm64' | 'win32-x64';
export type RuntimeAdapter = 'python' | 'java' | 'dotnet' | 'go' | 'rust' | 'native';
export interface RemoteRuntimeAsset { url: string; sha256: string; format: 'tar.gz' | 'zip' | 'file'; entrypoint: string; executables?: string[]; }
export interface LocalRuntimeAsset { directory: string; entrypoint: string; executables?: string[]; }
export interface RuntimeSource { type: 'runtime'; adapter: RuntimeAdapter; assets: Partial<Record<RuntimeTarget, { app: RemoteRuntimeAsset | LocalRuntimeAsset; runtime?: RemoteRuntimeAsset | LocalRuntimeAsset }>>; }
export function validateRuntimeSource(value: unknown): RuntimeSource;
export function runtimeSourceTargets(value: unknown): RuntimeTarget[];
export function runtimeAdapterLabel(adapter: RuntimeAdapter): string;
export function isPublicRuntimeAddress(value: string): boolean;
