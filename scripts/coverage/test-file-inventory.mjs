import path from 'node:path';

/** Compare resolved Vitest specifications with file receipts, without inferring selection from a second glob. */
export function reconcileTestFileInventory({inventory,report,cwd,excluded=[]}){
 const normalize=value=>typeof value==='string'&&value.trim()&&!value.includes('\0')?path.resolve(cwd,value):null;
 const inventoryPresent=inventory!==null&&inventory!==undefined;
 const inventoryValid=inventory?.schemaVersion===1&&inventory?.phase==='before-collection'
  &&typeof inventory?.cwd==='string'&&path.resolve(inventory.cwd)===path.resolve(cwd)&&Array.isArray(inventory?.moduleIds);
 const reportValid=Array.isArray(report?.testResults);
 const expected=(Array.isArray(inventory?.moduleIds)?inventory.moduleIds:[]).map(normalize);
 const reported=(reportValid?report.testResults:[]).map(file=>normalize(file?.name));
 const invalidExpectedEntries=expected.flatMap((file,index)=>file?[]:[index]);
 const invalidReportedEntries=reported.flatMap((file,index)=>file?[]:[index]);
 const duplicates=files=>[...new Set(files.filter((file,index)=>file&&files.indexOf(file)!==index))].sort();
 const expectedFiles=expected.filter(Boolean).sort(),reportedFiles=reported.filter(Boolean).sort();
 const expectedSet=new Set(expectedFiles),reportedSet=new Set(reportedFiles);
 const missingFiles=[...expectedSet].filter(file=>!reportedSet.has(file)).sort();
 const unexpectedFiles=[...reportedSet].filter(file=>!expectedSet.has(file)).sort();
 const duplicateExpectedFiles=duplicates(expected),duplicateReportedFiles=duplicates(reported);
 const complete=!!inventoryValid&&reportValid&&expectedFiles.length>0
  &&![invalidExpectedEntries,invalidReportedEntries,missingFiles,unexpectedFiles,duplicateExpectedFiles,duplicateReportedFiles].some(files=>files.length);
 return {complete,inventoryPresent,inventoryValid:!!inventoryValid,reportValid,expectedFileCount:expected.length,reportedFileCount:reported.length,
  expectedFiles,reportedFiles,excludedFiles:excluded.map(normalize).filter(Boolean).sort(),
  missingFiles,unexpectedFiles,duplicateExpectedFiles,duplicateReportedFiles,invalidExpectedEntries,invalidReportedEntries};
}
