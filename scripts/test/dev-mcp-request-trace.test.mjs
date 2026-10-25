import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readRequestTrace} from '../dev-mcp/request-trace.mjs';
import {validateOutput} from '../dev-mcp/output-validation.mjs';

const launchId='11111111-1111-4111-8111-111111111111';
const request='22222222-2222-4222-8222-222222222222';
const other='33333333-3333-4333-8333-333333333333';
const buildId='44444444-4444-4444-8444-444444444444';
const timestamp='2026-10-26T01:00:01.000Z';
const metadata={launchId,generation:null,entryDigest:'a'.repeat(64),sourceSha256:null,startedAt:'2026-10-26T01:00:00.000Z'};
const base={schemaVersion:1,kind:'neurocenter-dev-trace',timestamp,launchId};
const build=change=>({...base,flow:'tool-build',event:'accepted',requestKey:request,buildId,operationId:'tool-build-'+buildId,...change});
const chat=change=>({...base,flow:'saved-chat',event:'started',conversationId:other,turnId:buildId,requestId:request,attemptId:request,...change});
const readLog=rows=>async()=>({text:rows.map(row=>typeof row==='string'?row:JSON.stringify(row)).join('\n'),truncated:false,
    launch:metadata,observedAt:timestamp,currentProcessCorrelation:{state:'historical',reason:'launch-process-exited'}});

test('trace selects one request within a retained launch and never promotes an event to complete acceptance',async()=>{
    const value=await readRequestTrace('/unused',{flow:'tool-build',request,launchId},{readLog:async(root,service,options)=>{
        assert.equal(service,'catalog');assert.equal(options.launchId,launchId);assert.equal(options.maxBytes,32768);
        return readLog([build({event:'requested',buildId:undefined,operationId:undefined}),build({requestKey:other}),build({event:'succeeded'})])();
    }});
    assert.equal(value.state,'observed');assert.equal(value.events.length,2);assert.equal(value.events[1].event,'succeeded');
    assert.equal(value.currentProcessCorrelation.state,'historical');assert.equal(Object.hasOwn(value,'complete'),false);
    validateOutput('request_trace',value);
});

test('closed trace records reject payloads, cross-launch labels, invalid identities and operation substitution',async()=>{
    const value=await readRequestTrace('/unused',{flow:'tool-build',request},{readLog:readLog([
        build({payload:'PRIVATE_PROMPT'}),build({launchId:other}),build({operationId:'tool-build-'+other}),
        build({timestamp:'2026-02-30T01:00:01.000Z'}),build({timestamp:'2026-10-26T00:00:00.000Z'}),build({event:'made-up'}),
        build({requestKey:'PRIVATE_TOKEN'}),'{"kind":"neurocenter-dev-trace",',build(),
    ])});
    assert.equal(value.events.length,1);assert.equal(value.rejectedRecords,7);
    assert.ok(!JSON.stringify(value).includes('PRIVATE'));validateOutput('request_trace',value);
});

test('a malformed flow object cannot abort the observation of a later valid trace record',async()=>{
    const value=await readRequestTrace('/unused',{flow:'tool-build',request},{readLog:readLog([
        build({flow:{toString:null}}),build(),
    ])});
    assert.equal(value.events.length,1);assert.equal(value.rejectedRecords,1);validateOutput('request_trace',value);
});

test('array UUIDs are rejected instead of entering public saved-chat events through string coercion',async()=>{
    const value=await readRequestTrace('/unused',{flow:'saved-chat',request},{readLog:readLog([
        chat({conversationId:[other]}),chat(),
    ])});
    assert.equal(value.events.length,1);assert.equal(value.rejectedRecords,1);validateOutput('request_trace',value);
});

test('saved-chat retries remain separate attempts of the same turn, including historical non-v4 request UUIDs',async()=>{
    const historic='55555555-5555-1555-9555-555555555555';
    const value=await readRequestTrace('/unused',{flow:'saved-chat',request:historic},{readLog:readLog([
        chat({event:'cancelled'}),chat({event:'retried',requestId:historic,attemptId:historic}),
        chat({requestId:historic,attemptId:request}),chat({event:'succeeded',requestId:historic,attemptId:historic}),
    ])});
    assert.deepEqual(value.events.map(row=>row.event),['retried','succeeded']);assert.equal(value.rejectedRecords,1);
    assert.ok(value.events.every(row=>row.attemptId===historic));validateOutput('request_trace',value);
});

test('trace limits preserve truncation and text labels without launch provenance remain unavailable',async()=>{
    const value=await readRequestTrace('/unused',{flow:'tool-build',request,limit:1},{readLog:readLog([build(),build({event:'succeeded'})])});
    assert.equal(value.truncated,true);assert.equal(value.events.length,1);
    const unavailable=await readRequestTrace('/unused',{flow:'tool-build',request},{readLog:async()=>({...await readLog([build()])(),launch:null,
        currentProcessCorrelation:{state:'unknown',reason:'append-log-without-launch-provenance'}})});
    assert.equal(unavailable.state,'unavailable');assert.deepEqual(unavailable.events,[]);validateOutput('request_trace',unavailable);
});

test('trace validates identifiers and cancellation before reading files',async()=>{
    let reads=0;const reader=async()=>{reads++;throw Error('MUST_NOT_READ');};
    for(const options of [{flow:'other',request},{flow:'tool-build',request:'../secret'},
        {flow:'saved-chat',request,launchId:'../log'},{flow:'tool-build',request,limit:101}])
        await assert.rejects(readRequestTrace('/unused',options,{readLog:reader}),error=>error.code==='INVALID_ARGUMENT');
    const controller=new AbortController();controller.abort();
    await assert.rejects(readRequestTrace('/unused',{flow:'tool-build',request},{readLog:reader,signal:controller.signal}),error=>error.code==='CANCELLED');
    assert.equal(reads,0);
});
