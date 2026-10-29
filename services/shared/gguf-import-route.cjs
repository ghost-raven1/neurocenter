'use strict';
const {canonicalAccessRoute}=require('./access-route.cjs');
/** The model file uses its own binary data plane, never a JSON/base64 body. */
function ggufImportContentRoute(method,value){const route=canonicalAccessRoute(value);return typeof method==='string'&&method.toUpperCase()==='PUT'&&/^\/api\/models\/gguf-imports\/[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-4[a-fA-F0-9]{3}-[89aAbB][a-fA-F0-9]{3}-[a-fA-F0-9]{12}\/content$/.test(route||'')?route:undefined;}
module.exports={ggufImportContentRoute};
