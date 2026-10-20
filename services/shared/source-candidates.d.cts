export interface PackageEntrypoints {candidates:string[];runnableKinds:Array<'mcp'|'plugin'>;recommendedKind?:'mcp'|'plugin'}
/** Declared executable commands are distinct from library exports and Node condition alternatives. */
export function packageEntrypoints(metadata:Record<string,unknown>):PackageEntrypoints;
