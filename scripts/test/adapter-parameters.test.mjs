import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ADAPTER_PARAMETER_DEFINITIONS as definitions,normalizeAdapterParameters,applyAdapterParameters,adapterParameterIssues} from '../../services/shared/adapter-parameters.cjs';

test('Arbitrary parameter names/count and nested false/null survive without an execution allowlist',()=>{
 const value=Object.fromEntries(Array.from({length:200},(_,i)=>['custom_'+i,{enabled:false,items:[null,0,'exact']} ]));
 assert.deepEqual(normalizeAdapterParameters(value),value);assert.equal(Object.keys(normalizeAdapterParameters(value)).length,200);
});
test('Canonical nested object ordering preserves arrays and JSON types',()=>{
 assert.equal(JSON.stringify(normalizeAdapterParameters({b:{z:0,a:false},a:[null,'x']})),JSON.stringify(normalizeAdapterParameters({a:[null,'x'],b:{a:false,z:0}})));
});
for(const key of ['model','messages','input','instructions','previous_response_id','tools','tool_choice','stream','Headers','Authorization','api_key','baseURL','url','fetch','timeoutMs','responseModel','credentials'])test('Protected owner cannot be overridden by '+key,()=>{
 assert.throws(()=>normalizeAdapterParameters({[key]:'not-exported-value'}),error=>error.code==='ADAPTER_PARAMETERS_INVALID'&&!error.message.includes('not-exported-value'));
});
test('Non-JSON values, unsafe property names, sparse arrays and prototype-bearing objects are rejected',()=>{
 for(const value of [{v:undefined},{v:NaN},{v:Infinity},{v:1n},{v:new Date()},{v:()=>0},JSON.parse('{"__proto__":{"x":1}}'),{v:new Array(2)},Object.create({x:1})])assert.throws(()=>normalizeAdapterParameters(value));
});
test('Size, depth and node budgets fail before executing an adapter',()=>{
 let nested=null;for(let i=0;i<9;i++)nested={next:nested};
 for(const value of [{big:'x'.repeat(65537)},nested,{many:Array.from({length:4096},()=>0)}])assert.throws(()=>normalizeAdapterParameters(value));
});
test('Each adapter has an explicit wire path and conflicts are errors instead of dropped values',()=>{
 const parameters={custom:{enabled:false,value:null}};
 assert.deepEqual(applyAdapterParameters({model:'fixed',messages:[],stream:false},parameters,definitions['openai-chat-completions']),{model:'fixed',messages:[],stream:false,...parameters});
 assert.deepEqual(applyAdapterParameters({model:'fixed',input:[],stream:false},parameters,definitions['openai-responses']),{model:'fixed',input:[],stream:false,...parameters});
 assert.deepEqual(applyAdapterParameters({model:'fixed',options:{temperature:0}},parameters,definitions.ollama),{model:'fixed',options:{temperature:0,...parameters}});
 assert.throws(()=>applyAdapterParameters({temperature:0},{temperature:1},definitions['openai-chat-completions']),/одном месте/);
});
test('Discovery reports exact safe names and JSON types, and never unknown values',()=>{
 const secret='never-export-this-fixture-value';
 const issues=adapterParameterIssues({temperature:0,custom:{apiKey:secret},flag:false,list:[secret],nullable:null},['temperature']);
 assert.deepEqual(issues,[{name:'custom',type:'object'},{name:'flag',type:'boolean'},{name:'list',type:'array'},{name:'nullable',type:'null'}]);
 assert.ok(!JSON.stringify(issues).includes(secret));
});
