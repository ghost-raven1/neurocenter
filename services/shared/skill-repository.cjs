'use strict';
const path=require('node:path');
const {pathToFileURL}=require('node:url');
/** Preserve native import when called by the Nest CommonJS build. */
async function readSkillRepository(source,stage){
 const build=process.env.TOOL_BUILD_SCRIPT||path.resolve(__dirname,'../../scripts/catalog-plugins/build.mjs');
 const reader=await import(pathToFileURL(path.join(path.dirname(build),'skill-source.mjs')).href);
 return reader.readSkillRepository(source,stage);
}
module.exports={readSkillRepository};
