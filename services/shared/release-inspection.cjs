'use strict';
const path=require('node:path');
const {pathToFileURL}=require('node:url');
/** Shared CJS keeps native dynamic import intact under the Nest CommonJS compiler. */
async function inspectGithubReleaseAsset(asset,entrypoint){
 const build=process.env.TOOL_BUILD_SCRIPT||path.resolve(__dirname,'../../scripts/catalog-plugins/build.mjs');
 const inspector=await import(pathToFileURL(path.join(path.dirname(build),'release-inspection.mjs')).href);
 return inspector.inspectGithubReleaseAsset(asset,entrypoint);
}
async function inspectGithubRepository(source,entrypoint){
 const build=process.env.TOOL_BUILD_SCRIPT||path.resolve(__dirname,'../../scripts/catalog-plugins/build.mjs');
 const inspector=await import(pathToFileURL(path.join(path.dirname(build),'release-inspection.mjs')).href);
 return inspector.inspectGithubRepository(source,entrypoint);
}
module.exports={inspectGithubReleaseAsset,inspectGithubRepository};
