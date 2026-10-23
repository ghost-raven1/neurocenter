export const CODEX_PLUGIN_SOURCE: Readonly<{url:string;commit:string;subdirectory:string;entrypoint:string;adapter:'opencode-codex-bridge'}>;
export function isPreparedCodexRepository(source:unknown):boolean;
export const CODEX_MANAGED_INSTALL_MESSAGE:string;
export function isManagedCodexConnectorPackage(value:unknown):boolean;
