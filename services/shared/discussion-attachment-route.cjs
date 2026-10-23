'use strict';
const {canonicalAccessRoute}=require('./access-route.cjs');
const DISCUSSION_ATTACHMENT_MAX_BYTES=10*1024**2;
/** Raw attachments bypass JSON parsing only on this exact authenticated route. */
function discussionAttachmentUploadRoute(method,path){
 const route=canonicalAccessRoute(path);
 return String(method).toUpperCase()==='POST'&&route==='/api/discussions/attachments'?route:undefined;
}
/** Downloads always pass fresh discussion ACL before private bytes are returned. */
function discussionAttachmentDownloadRoute(method,path){
 const route=canonicalAccessRoute(path);
 return ['GET','HEAD'].includes(String(method).toUpperCase())&&/^\/api\/discussions\/attachments\/[a-f0-9-]{36}\/content$/.test(route||'')?route:undefined;
}
module.exports={discussionAttachmentUploadRoute,discussionAttachmentDownloadRoute,DISCUSSION_ATTACHMENT_MAX_BYTES};
