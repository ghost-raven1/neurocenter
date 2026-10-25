import fs from 'node:fs/promises';
import {createInterface} from 'node:readline';
import {isDeepStrictEqual} from 'node:util';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

export const mockName=operation=>operation.id.replaceAll('-','_');
const field=value=>Array.isArray(value)?{type:'array',items:{type:'string',enum:value},minItems:value.length,maxItems:value.length}:{type:'string',enum:[value]};

/** Expose operations and input shapes only; gold outcomes and controls stay outside the model context. */
export function mockTools(scenario){
    return scenario.operations.map(operation=>({name:mockName(operation),description:`Mock ${operation.tool}: ${operation.id}. Returns selected local evidence. Commands/writes are simulated and never executed.`,
        inputSchema:{type:'object',properties:Object.fromEntries(Object.entries(operation.input).map(([key,value])=>[key,field(value)])),required:Object.keys(operation.input),additionalProperties:false},
        annotations:{readOnlyHint:operation.effect==='read',openWorldHint:false}}));
}

/** The trusted host records every requested mock action, including denied/invalid attempts. */
export function mockResult(scenario,runId,sequence,params){
    const operation=scenario.operations.find(item=>mockName(item)===params?.name),action='a'+sequence;
    const valid=!!operation&&isDeepStrictEqual(operation.input,params.arguments??{});
    const result=valid?{runId,action,observations:operation.observations}:{runId,action,error:'Unknown mock operation or invalid selected input.'};
    return {record:{runId,sequence,action,tool:params?.name??null,input:params?.arguments??{},operation:operation?.id??null,valid,result},
        response:{content:[{type:'text',text:JSON.stringify(result)}],isError:!valid}};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
    const [scenarioPath,ledger,runId]=process.argv.slice(2);
    const scenario=JSON.parse(await fs.readFile(scenarioPath,'utf8'));let sequence=0;
    const lines=createInterface({input:process.stdin,crlfDelay:Infinity});
    for await(const line of lines){
        let request;try{request=JSON.parse(line);}catch{continue;}
        if(request.id===undefined)continue;
        let result;
        if(request.method==='initialize')result={protocolVersion:request.params?.protocolVersion??'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'neurocenter-eval-mock',version:'1.0.0'}};
        else if(request.method==='tools/list')result={tools:mockTools(scenario)};
        else if(request.method==='tools/call'){
            const value=mockResult(scenario,runId,++sequence,request.params);
            await fs.appendFile(ledger,JSON.stringify(value.record)+'\n',{mode:0o600});result=value.response;
        }else if(request.method==='ping')result={};
        else{process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:-32601,message:'Unsupported mock method.'}})+'\n');continue;}
        process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\n');
    }
}
