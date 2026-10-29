'use strict';
const {ggufImportContentRoute}=require('./gguf-import-route.cjs');

/** GGUF owns its durable upload deadline; other requests retain the server's original body deadline. */
function ggufRequestTimeouts(server){
 const original=server.requestTimeout;server.requestTimeout=0;
 return function(req,res,next){
  const pathname=req.path||String(req.url||'').split('?')[0];
  if(!original||req.complete||ggufImportContentRoute(req.method,pathname)){next();return;}
  let timer;
  const done=()=>{clearTimeout(timer);req.off('end',done);req.off('aborted',done);res.off('close',done);};
  timer=setTimeout(()=>{done();if(req.complete||res.destroyed)return;if(res.headersSent){res.destroy();return;}res.statusCode=408;res.setHeader('Connection','close');res.setHeader('Content-Type','application/json');res.end(JSON.stringify({statusCode:408,message:'Истекло время получения запроса.'}));},original);timer.unref();
  req.once('end',done);req.once('aborted',done);res.once('close',done);next();
 };
}
module.exports={ggufRequestTimeouts};
