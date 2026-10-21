'use strict';
const {canonicalAccessRoute}=require('./access-route.cjs');
/** Only immutable project snapshot chunks bypass the JSON control-plane parser. */
function snapshotContentRoute(method,value){
    const route=canonicalAccessRoute(value);
    return typeof method==='string'&&method.toUpperCase()==='PUT'&&/^\/api\/projects\/[a-zA-Z0-9_-]{1,200}\/snapshot-uploads\/[a-f0-9-]{36}\/blobs\/[a-f0-9]{64}$/.test(route||'')?route:undefined;
}
function snapshotDownloadRoute(method,value){
    const route=canonicalAccessRoute(value);
    return ['GET','HEAD'].includes(String(method).toUpperCase())&&/^\/api\/projects\/[a-zA-Z0-9_-]{1,200}\/versions\/[a-f0-9-]{36}\/blobs\/[a-f0-9]{64}$/.test(route||'')?route:undefined;
}
function snapshotPublicationRoute(method,value){
    const route=canonicalAccessRoute(value);
    const match=/^\/api\/projects\/([a-zA-Z0-9_-]{1,200})\/snapshot-uploads\/([a-f0-9-]{36})\/(manifest|complete|status|blobs\/[a-f0-9]{64})$/.exec(route||'');
    if(!match||String(method).toUpperCase()!==(match[3]==='status'?'GET':match[3].startsWith('blobs/')?'PUT':'POST'))return;
    return {projectId:match[1],snapshotId:match[2]};
}
module.exports={snapshotContentRoute,snapshotDownloadRoute,snapshotPublicationRoute};
