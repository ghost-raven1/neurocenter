import {describe,expect,it,vi} from 'vitest';
import {AssetSourcesService} from '../src/asset-sources/asset-sources.service';

const sha='a'.repeat(64),buildId='b'.repeat(64),version='0.10.0',target='darwin-arm64';
function receipt(id:string,repository:string){
    const file=`neurocenter-asset-sync-${target}-${version}.tgz`,metadata={version,target,buildId,sha256:sha,bytes:24,nodeVersion:'24.22.0',ragSupported:false,probeEngine:{file:'bin/opencode-probe',version:'1.0.0',sha256:sha}};
    return {external_id:id,source_commit:'c'.repeat(40),descriptor:{schemaVersion:1,id,kind:'bridge',version,license:{spdx:'MIT'},
        compatibility:{bridgeProtocol:2},source:{type:'release',repository:'https://github.com/'+repository,tag:'bridge-v'+version},
        card:{name:id,description:'Synthetic bridge supply'},delivery:{type:'bridge-release',release:{schemaVersion:1,release:'bridge-v'+version,version,buildId,
            artifacts:[{file,url:`https://github.com/${repository}/releases/download/bridge-v${version}/${file}`,metadata}]}}},
        blobs:[{sha256:sha,bytes:24,target}]};
}
function fixture(rows:ReturnType<typeof receipt>[]){
    const query=vi.fn().mockResolvedValueOnce({rows:[{installed_repository:'source/new',installed_asset_id:'new-bridge'}]}).mockResolvedValueOnce({rows});
    const checkedPath=vi.fn().mockResolvedValue('/owned/synthetic-blob');
    const supply=(selected?:string)=>AssetSourcesService.prototype.bridgeSupply.call({pool:{query},blobs:{checkedPath}} as never,selected);
    return {supply,checkedPath};
}
describe('Version-only bridge download routes preserve payload identity across source changes',()=>{
    it('Different asset IDs and download hosts can serve one historical version with identical bytes and metadata',async()=>{
        const f=fixture([receipt('old-bridge','source/old'),receipt('new-bridge','source/new')]);
        const result=await f.supply(version);expect(result.version).toBe(version);expect(result.artifacts).toHaveLength(1);
        expect(result.artifacts[0].sha256).toBe(sha);expect(f.checkedPath).toHaveBeenCalledWith(sha,24);
    });
    it('A reused version and buildId with changed artifact bytes is rejected before opening a blob',async()=>{
        const first=receipt('old-bridge','source/old'),second=receipt('new-bridge','source/new');second.descriptor.delivery.release.artifacts[0].metadata.sha256='d'.repeat(64);
        const f=fixture([first,second]);await expect(f.supply(version)).rejects.toMatchObject({status:409});expect(f.checkedPath).not.toHaveBeenCalled();
    });
});
