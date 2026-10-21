import path from 'node:path';
import {fileURLToPath} from 'node:url';
const shared=fileURLToPath(new URL('.',import.meta.url)).replace(/\/$/,'');
/** Explicit source inclusion keeps never-imported production modules visible in each baseline. */
export function packageCoverage(packageRoot){
 const sharedPattern=shared.split(path.sep).join('/');
 return {provider:'v8',allowExternal:true,include:['src/**/*.{ts,tsx,js,cjs,mjs}',sharedPattern+'/**/*.{cjs,mjs,js}'],
  exclude:['**/*.d.ts','**/*.d.cts',sharedPattern+'/test-coverage.mjs'],reportOnFailure:true,skipFull:false,
  reporter:['text-summary','json','json-summary','lcov','html'],reportsDirectory:process.env.NEUROCENTER_COVERAGE_DIR||path.join(packageRoot,'coverage')};
}
