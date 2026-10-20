'use strict';
const path=require('node:path');
const {pathToFileURL}=require('node:url');
/** Native ESM import remains intact under the Nest CommonJS compiler. */
async function inspectUploadArchive(filename,options){
 const build=process.env.TOOL_BUILD_SCRIPT||path.resolve(__dirname,'../../scripts/catalog-plugins/build.mjs');
 const inspector=await import(pathToFileURL(path.join(path.dirname(build),'upload-inspection.mjs')).href);
 return inspector.inspectUploadArchive(filename,options);
}
module.exports={inspectUploadArchive};
