/** Native c8 and Vitest AST counters must never masquerade as one comparable coverage denominator. */
export function coverageMethod(kinds,allowExperimental=false){
 const methods=[...new Set(kinds.flat())];
 if(methods.includes('experimental-mixed-instrumentation')||methods.length>1){
  if(!allowExperimental)throw Error('Cannot merge Vitest AST and native c8 counters as one comparable percentage. Keep behavior evidence separate, or explicitly pass --experimental-native-union.');
  return {coverageKind:'experimental-mixed-instrumentation',comparablePercentages:false};
 }
 return {coverageKind:methods[0]??'unknown',comparablePercentages:methods.length===1};
}
export function manifestCoverageKinds(manifest){
 if(manifest.coverageKind)return [manifest.coverageKind];
 if(manifest.profile==='retained-runs-merge')return ['experimental-mixed-instrumentation'];
 return [...(manifest.packages?.length?['vitest-ast-v8']:[]),...(manifest.native||manifest.integration?['native-c8-v8']:[])];
}
