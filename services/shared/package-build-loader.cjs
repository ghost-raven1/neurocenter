'use strict';
const {pathToFileURL}=require('node:url');
/** Native async ESM bridge for the trusted inspector; source files are never imported. */
module.exports={loadBuildInspector:filename=>import(pathToFileURL(filename).href)};
