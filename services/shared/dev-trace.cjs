'use strict';
const fs=require('node:fs');

const DEV_TRACE_KIND='neurocenter-dev-trace';
const TOOL_BUILD_TRACE_EVENTS=Object.freeze(['requested','accepted','replayed','started','cancel-requested','succeeded','failed','cancelled']);
const SAVED_CHAT_TRACE_EVENTS=Object.freeze(['accepted','retried','started','cancel-requested','succeeded','failed','cancelled']);
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const uuid4=value=>uuid(value)&&value[14]==='4'&&/[89ab]/i.test(value[19]);

/** Only fixed events and UUID identities reach stdout; payloads, errors and caller metadata are never copied. */
function emit(flow,event,ids,{environment=process.env,write=line=>fs.writeSync(process.stdout.fd,line),now=()=>new Date()}={}){
    try{
        if(environment.NEUROCENTER_DEV_TRACES!=='1'||!uuid4(environment.NEUROCENTER_DEV_LAUNCH_ID))return false;
        const record={schemaVersion:1,kind:DEV_TRACE_KIND,timestamp:now().toISOString(),launchId:environment.NEUROCENTER_DEV_LAUNCH_ID.toLowerCase(),flow,event};
        if(flow==='tool-build'){
            if(!TOOL_BUILD_TRACE_EVENTS.includes(event)||!uuid4(ids.requestKey)||ids.buildId!==undefined&&!uuid4(ids.buildId))return false;
            record.requestKey=ids.requestKey.toLowerCase();
            if(ids.buildId!==undefined){record.buildId=ids.buildId.toLowerCase();record.operationId='tool-build-'+record.buildId;}
        }else{
            if(!SAVED_CHAT_TRACE_EVENTS.includes(event)||!uuid(ids.conversationId)||!uuid(ids.turnId)||!uuid(ids.requestId))return false;
            record.conversationId=ids.conversationId.toLowerCase();record.turnId=ids.turnId.toLowerCase();
            record.requestId=record.attemptId=ids.requestId.toLowerCase();
        }
        const result=write(JSON.stringify(record)+'\n');
        if(result&&typeof result.then==='function')Promise.resolve(result).catch(()=>{});
        return true;
    }catch{return false;}
}

const traceToolBuild=(event,ids,options)=>emit('tool-build',event,ids,options);
const traceSavedChat=(event,ids,options)=>emit('saved-chat',event,ids,options);
module.exports={DEV_TRACE_KIND,TOOL_BUILD_TRACE_EVENTS,SAVED_CHAT_TRACE_EVENTS,traceToolBuild,traceSavedChat};
