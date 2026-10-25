import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,realpath,mkdir,writeFile,readFile,rm,utimes,symlink,link} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createDiagnostics} from '../dev-mcp/diagnostics.mjs';
import {readOwnedFile} from '../dev-mcp/safe-file.mjs';

const relative='.run/logs/neurocenter-catalog.log';
const correlation={state:'unknown',reason:'append-log-without-launch-provenance'};

/** Own every file used by log provenance checks; no live service or process is read. */
async function fixture(t,text='',serviceDetailsEnabled=true){
    const root=await realpath(await mkdtemp(path.join(tmpdir(),'nc log provenance ')));
    t.after(()=>rm(root,{recursive:true,force:true}));
    await writeFile(path.join(root,'package.json'),JSON.stringify({name:'neurocenter-workspace'}));
    await mkdir(path.join(root,'.run/logs'),{recursive:true});
    const filename=path.join(root,relative);await writeFile(filename,text);
    return {root,filename,diagnostics:await createDiagnostics(root,{serviceDetailsEnabled})};
}

test('a stale error carries its stable file timestamp without being attributed to the current process',async t=>{
    const text='Старая ошибка\ntoken=PRIVATE_VALUE\n',f=await fixture(t,text);
    const modified=new Date('2020-02-03T04:05:06.000Z');await utimes(f.filename,modified,modified);
    const before=Date.now(),value=await f.diagnostics.serviceLogs('catalog',2),after=Date.now();
    assert.equal(value.details.fileModifiedAt,modified.toISOString());
    assert.ok(Date.parse(value.details.observedAt)>=before&&Date.parse(value.details.observedAt)<=after);
    assert.equal(value.details.fileBytes,Buffer.byteLength(text));
    assert.equal(value.details.bytesRead,Buffer.byteLength(text));
    assert.deepEqual(value.details.currentProcessCorrelation,correlation);
    assert.ok(!JSON.stringify(value).includes('PRIVATE_VALUE'));
    assert.deepEqual(Object.keys(value.details).sort(),['observedAt','fileModifiedAt','fileBytes','bytesRead','currentProcessCorrelation'].sort());
});

test('fresh mtime and forged launch markers remain uncorrelated log contents',async t=>{
    const f=await fixture(t,'[launch] current=true pid=999999 runId=pretend\nready\n');
    const future=new Date('2030-01-02T03:04:05.000Z');await utimes(f.filename,future,future);
    const value=await f.diagnostics.serviceLogs('catalog');
    assert.equal(value.details.fileModifiedAt,future.toISOString());
    assert.deepEqual(value.details.currentProcessCorrelation,correlation);
    assert.equal(Object.hasOwn(value.details,'pid'),false);
});

test('empty logs expose zero byte facts and an explicit unknown process correlation',async t=>{
    const f=await fixture(t),value=await f.diagnostics.serviceLogs('catalog');
    assert.equal(value.text,'');assert.equal(value.lines,0);assert.equal(value.truncated,false);
    assert.equal(value.details.fileBytes,0);assert.equal(value.details.bytesRead,0);
    assert.ok(Number.isFinite(Date.parse(value.details.observedAt)));
    assert.ok(Number.isFinite(Date.parse(value.details.fileModifiedAt)));
    assert.deepEqual(value.details.currentProcessCorrelation,correlation);
});

test('tail details describe the bounded file read rather than redacted or selected text size',async t=>{
    const text='old\n'.repeat(20000)+'one\ntwo\n',f=await fixture(t,text);
    const value=await f.diagnostics.serviceLogs('catalog',1);
    assert.equal(value.text,'two');assert.equal(value.lines,1);assert.equal(value.truncated,true);
    assert.equal(value.details.fileBytes,Buffer.byteLength(text));assert.equal(value.details.bytesRead,32768);
    assert.deepEqual(value.details.currentProcessCorrelation,correlation);
});

test('safe file metadata comes from the checked descriptor while retaining bounded read facts',async t=>{
    const f=await fixture(t,'abcdef'),modified=new Date('2021-06-07T08:09:10.000Z');await utimes(f.filename,modified,modified);
    const before=Date.now(),value=await readOwnedFile(f.root,relative,{limit:3,tail:true}),after=Date.now();
    assert.equal(value.text,'def');assert.equal(value.bytesRead,3);assert.equal(value.fileBytes,6);assert.equal(value.truncated,true);
    assert.equal(value.fileModifiedAt,modified.toISOString());
    assert.ok(Date.parse(value.observedAt)>=before&&Date.parse(value.observedAt)<=after);
});

test('disabling service details preserves log reading and the prior public result',async t=>{
    const f=await fixture(t,'older\nnewer\n',false),value=await f.diagnostics.serviceLogs('catalog',1);
    assert.equal(value.text,'newer');assert.equal(value.lines,1);assert.equal(Object.hasOwn(value,'details'),false);
    assert.deepEqual(Object.keys(value).sort(),['service','text','lines','truncated','evidence'].sort());
});

test('log provenance keeps service/line validation and linked-file guards',async t=>{
    const f=await fixture(t,'private sentinel');
    for(const [service,lines]of [['../outside',1],['catalog',0],['catalog',101],['catalog',1.5]])
        await assert.rejects(f.diagnostics.serviceLogs(service,lines),error=>error.code==='INVALID_ARGUMENT');
    const sentinel=path.join(f.root,'sentinel');await writeFile(sentinel,'DO_NOT_DISCLOSE');
    await rm(f.filename);await link(sentinel,f.filename);
    await assert.rejects(f.diagnostics.serviceLogs('catalog'),error=>error.code==='UNSAFE_FILE');
    await rm(f.filename);await symlink(sentinel,f.filename);
    await assert.rejects(f.diagnostics.serviceLogs('catalog'),error=>error.code==='UNSAFE_FILE');
    assert.equal(await readFile(sentinel,'utf8'),'DO_NOT_DISCLOSE');
});
