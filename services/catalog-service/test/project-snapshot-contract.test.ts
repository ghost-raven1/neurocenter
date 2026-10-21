import {describe,it,expect} from 'vitest';
import {createHash} from 'node:crypto';
import {normalizeSnapshotManifest,snapshotManifestHash,SNAPSHOT_CHUNK_BYTES} from '../../shared/project-snapshot.cjs';

const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const manifest=()=>({format:'neurocenter.lancedb-snapshot',schemaVersion:1,sdkVersion:'0.29.0',
    tables:[{name:'chunks',version:1,rows:1,schemaSha256:sha('schema')}],
    files:[{path:'chunks.lance/data/a.lance',size:3,sha256:sha('abc'),chunks:[{sha256:sha('abc'),size:3}]}]});
describe('immutable project snapshot manifest',()=>{
    it('normalizes key ordering without changing chunk order or hashes',()=>{
        const first=manifest(),second={files:first.files,tables:first.tables,sdkVersion:first.sdkVersion,schemaVersion:1,format:first.format};
        expect(snapshotManifestHash(first)).toBe(snapshotManifestHash(second));
        expect(normalizeSnapshotManifest(first).files[0].chunks[0].sha256).toBe(sha('abc'));
    });
    it.each(['../secret','/absolute','chunks.lance/../secret','chunks.lance/a\\b','chunks.lance//a','chunks.lance/a\u0000','other.lance/data/a'])('rejects unsafe or undeclared file %s',path=>{
        const value=manifest();value.files[0].path=path;expect(()=>normalizeSnapshotManifest(value)).toThrow();
    });
    it('rejects case-fold collisions, duplicate tables and extra transport fields',()=>{
        const value=manifest();value.files.push({...value.files[0],path:'chunks.lance/data/A.lance'});expect(()=>normalizeSnapshotManifest(value)).toThrow();
        const duplicate=manifest();duplicate.tables.push({...duplicate.tables[0]});expect(()=>normalizeSnapshotManifest(duplicate)).toThrow();
        expect(()=>normalizeSnapshotManifest({...manifest(),apiKey:'private'})).toThrow();
    });
    it('rejects wrong chunk totals, invalid hashes, non-finite sizes and oversized chunks',()=>{
        for(const patch of [{size:4},{size:Infinity},{sha256:'not-sha'},{chunks:[{sha256:sha('abc'),size:SNAPSHOT_CHUNK_BYTES+1}]}]){
            const value=manifest();Object.assign(value.files[0],patch);expect(()=>normalizeSnapshotManifest(value)).toThrow();
        }
    });
    it('requires a complete nonempty table inventory but supports an empty file',()=>{
        expect(()=>normalizeSnapshotManifest({...manifest(),tables:[]})).toThrow();
        const value=manifest();value.files[0]={...value.files[0],size:0,sha256:sha(''),chunks:[]};expect(normalizeSnapshotManifest(value).files[0].size).toBe(0);
    });
});
