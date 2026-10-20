'use strict';
const {canonicalAccessRoute}=require('./access-route.cjs');
/** Only this authenticated upload endpoint bypasses JSON parsing for its raw data plane. */
function sourceUploadContentRoute(method,value){const route=canonicalAccessRoute(value);return typeof method==='string'&&method.toUpperCase()==='PUT'&&/^\/api\/tool-builds\/uploads\/[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-4[a-fA-F0-9]{3}-[89aAbB][a-fA-F0-9]{3}-[a-fA-F0-9]{12}\/content$/.test(route||'')?route:undefined;}
module.exports={sourceUploadContentRoute};
