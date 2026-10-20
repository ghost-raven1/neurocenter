import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir,writeFile,access} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {readModelAsset} from '../models/source-asset.mjs';
import {parseModelPublishArguments} from '../models/publish-cli.mjs';
import {modelSourceFixture} from './model-source.fixture.mjs';

const digest=value=>createHash('sha256').update(value).digest('hex');
test('Producer detects one model from local manifest and writes only the new source envelope',async t=>{
    const f=await modelSourceFixture(t),result=await f.prepare(),asset=await readModelAsset(result.descriptor);
    assert.equal(result.published,false);assert.equal(asset.kind,'model');assert.equal(asset.card.descriptor.capability,'embedding');assert.equal(asset.card.descriptor.dimension,null);
    assert.equal(asset.source.repository,'https://github.com/ghost-raven1/neurocenter-assets');
    assert.equal(asset.delivery.lock.manifestSha256,digest(Buffer.from(JSON.stringify(f.manifest))));
    const files=await readdir(f.output);assert.ok(files.includes('asset.json'));assert.ok(files.every(name=>name==='asset.json'||/^model-[a-f0-9]{64}-\d{3}\.bin$/.test(name)));
    assert.doesNotMatch(await readFile(result.descriptor,'utf8'),/PRIVATE KEY|token|password|deviceId|catalogId/);
    await assert.rejects(access(path.join(f.root,'scripts/models/model-registry.json')),{code:'ENOENT'});
});
test('Repeated producer reuses exact checked parts; no metadata or unrelated model is changed',async t=>{
    const f=await modelSourceFixture(t),first=await f.prepare(),before=await readFile(first.descriptor);
    const second=await f.prepare({}, {pack:()=>assert.fail('Must reuse verified output')});assert.deepEqual(second,first);assert.deepEqual(await readFile(second.descriptor),before);
    assert.equal(await readFile(path.join(f.directory,'id_ed25519'),'utf8'),'PRIVATE KEY MUST NOT BE READ');
});
test('Unknown capability asks for the missing choice; dimension is never guessed from a model name',async t=>{
    const f=await modelSourceFixture(t,{name:'namespace/unknown:1'});
    await assert.rejects(f.prepare(),/Тип модели не определён/);await assert.rejects(access(f.output),{code:'ENOENT'});
    const result=await f.prepare({capability:'chat'});assert.equal((await readModelAsset(result.descriptor)).card.descriptor.dimension,null);
});
test('Changed local manifest, corrupt staged bytes and different source version cannot overwrite a prepared output',async t=>{
    const f=await modelSourceFixture(t),result=await f.prepare(),asset=await readModelAsset(result.descriptor),before=await readFile(result.descriptor);
    await assert.rejects(f.prepare({version:'different-version'}),/другому ассету/);
    const part=asset.delivery.bundle.files.flatMap(file=>file.parts||[])[0];await writeFile(path.join(f.output,part.name),Buffer.alloc(part.size,7));
    await assert.rejects(f.prepare(),/SHA|Часть/);assert.deepEqual(await readFile(result.descriptor),before);
});
test('Invalid technical input fails before large-file packing',async t=>{
    const f=await modelSourceFixture(t);
    for(const values of [{dimension:0},{dimension:1.5},{capability:'unsupported'},{capability:'vision',dimension:128},{model:'latest'},{id:'invalid/id'}])await assert.rejects(f.prepare(values,{pack:()=>assert.fail('Invalid metadata must stop before pack')}));
});
test('Explicit publication verifies remote sizes and SHA then reads back the published release',async t=>{
    const f=await modelSourceFixture(t);let remote,uploads=0;
    const run=async args=>{
        assert.ok(args.includes('ghost-raven1/neurocenter-assets')||args[1]?.startsWith('repos/ghost-raven1/neurocenter-assets/'));
        if(args[0]==='api'){if(!remote)throw Object.assign(new Error('missing'),{stderr:'HTTP 404'});return JSON.stringify(remote);}
        if(args[1]==='create'){remote={tag_name:f.options.release,draft:true,assets:[]};return '';}
        if(args[1]==='upload'){uploads++;for(const filename of args.slice(args.indexOf('--repo')+2)){const bytes=await readFile(filename);remote.assets.push({name:path.basename(filename),size:bytes.length,digest:'sha256:'+digest(bytes)});}return '';}
        if(args[1]==='edit'){assert.ok(remote.assets.some(asset=>asset.name==='asset.json'));remote.draft=false;return '';}
        assert.fail('Unexpected gh call');
    };
    const first=await f.prepare({publish:true},{run});assert.equal(first.published,true);assert.equal(remote.draft,false);assert.ok(uploads>0);
    uploads=0;assert.equal((await f.prepare({publish:true},{run})).published,true);assert.equal(uploads,0);
});
test('Missing or mismatched remote assets never become a published receipt',async t=>{
    const f=await modelSourceFixture(t);
    await assert.rejects(f.prepare({publish:true},{run:async args=>args[0]==='api'?JSON.stringify({tag_name:f.options.release,draft:false,assets:[]}):assert.fail('No mutation of mismatched release')}),/отличается/);
});
test('New CLI rejects old recipe, old aliases and prototype flags before reading files',()=>{
    assert.equal(parseModelPublishArguments(['--model','fixture:1','--release','v1','--dimension','256']).dimension,256);
    for(const args of [['--recipe','old.json','--release','v1'],['--model','fixture:1','--tag','v1'],['constructor','oops'],['--model','a:1','--release','v1','--dimension','1.2']])assert.throws(()=>parseModelPublishArguments(args));
});
