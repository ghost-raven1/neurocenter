import path from 'node:path';
import {writeFile} from 'node:fs/promises';

/** Persist the actual resolved selection before Vitest loads or collects any test module. */
export default class InventoryReporter {
 async onTestRunStart(specifications){
  const filename=process.env.NEUROCENTER_COVERAGE_INVENTORY_FILE;
  if(!filename||!path.isAbsolute(filename))throw Error('Coverage inventory requires an explicit absolute receipt path.');
  await writeFile(filename,JSON.stringify({schemaVersion:1,phase:'before-collection',createdAt:new Date().toISOString(),
   cwd:process.cwd(),moduleIds:specifications.map(specification=>specification.moduleId)},null,2)+'\n',{mode:0o600,flag:'wx',flush:true});
 }
}
