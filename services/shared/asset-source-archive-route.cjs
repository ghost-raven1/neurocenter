'use strict';
const {canonicalAccessRoute}=require('./access-route.cjs');
const ASSET_SOURCE_ARCHIVE_MAX_BYTES=8*1024**3;
/** One authenticated raw route and byte limit serve repository and offline supply archives. */
function assetSourceArchiveRoute(method,value){
 const route=canonicalAccessRoute(value);
 return typeof method==='string'&&method.toUpperCase()==='PUT'&&route==='/api/asset-sources/archive'?route:undefined;
}
module.exports={assetSourceArchiveRoute,ASSET_SOURCE_ARCHIVE_MAX_BYTES};
