import assert from 'node:assert/strict';
import {test} from 'node:test';
import {validateSourceDependencies} from '../source-dependency-lock.mjs';

const manifest={dependencies:{'@opencode-ai/plugin':'>=1.16.0'}};
const lock={lockfileVersion:3,packages:{'':manifest,'node_modules/@opencode-ai/plugin':{
    version:'1.18.34',resolved:'https://registry.npmjs.org/@opencode-ai/plugin/-/plugin-1.18.34.tgz',integrity:'sha512-'+Buffer.alloc(64).toString('base64')}}};
test('Pinned psinetron dependency range uses the existing exact integrity lock without choosing latest',()=>{
    assert.doesNotThrow(()=>validateSourceDependencies(manifest,lock));
    for(const range of ['>=1.16.0 <2.0.0','1.16.x || >=1.18.0'])assert.doesNotThrow(()=>validateSourceDependencies({dependencies:{'@opencode-ai/plugin':range}},
        {...lock,packages:{...lock.packages,'':{dependencies:{'@opencode-ai/plugin':range}}}}));
});
test('Ranges require matching locked versions, official registry and integrity',()=>{
    assert.throws(()=>validateSourceDependencies(manifest),{code:'SOURCE_DEPENDENCY_LOCK_REQUIRED'});
    for(const change of [{version:'1.14.48'},{integrity:undefined},{resolved:'https://example.invalid/plugin.tgz'}]){
        const changed=structuredClone(lock);Object.assign(changed.packages['node_modules/@opencode-ai/plugin'],change);
        assert.throws(()=>validateSourceDependencies(manifest,changed),{code:'SOURCE_DEPENDENCY_INVALID'});
    }
    const changed=structuredClone(lock);changed.packages[''].dependencies={'@opencode-ai/plugin':'*'};
    assert.throws(()=>validateSourceDependencies(manifest,changed),{code:'SOURCE_DEPENDENCY_INVALID'});
});
test('Legacy exact caret and tilde dependencies remain accepted, non-registry sources do not',()=>{
    for(const version of ['1.0.0','^1.0.0','~1.0.0'])assert.doesNotThrow(()=>validateSourceDependencies({dependencies:{fixture:version}}));
    for(const version of ['file:../private','git+https://example.invalid/repo','https://example.invalid/pkg.tgz','latest'])
        assert.throws(()=>validateSourceDependencies({dependencies:{fixture:version}}),{code:'SOURCE_DEPENDENCY_INVALID'});
});
