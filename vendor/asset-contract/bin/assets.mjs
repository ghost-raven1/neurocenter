#!/usr/bin/env node
import {readFile,writeFile,lstat} from 'node:fs/promises';
import {loadRepository,selectAssets,assetDigest,toToolPublication,toSkillCreate,toModelRecord,toBridgeRelease,toAgentRecord,downloadArtifacts,createToolAsset,serializeAsset,assertIndexEvolution} from '../lib/index.mjs';

const help=`neurocenter-assets validate [directory]
neurocenter-assets list [directory]
neurocenter-assets preview <directory> <asset-id> [...]
neurocenter-assets export-tool <prepared-input.json> <new-asset.json>
neurocenter-assets compare <previous-index.json> <next-index.json>

Commands are local and never publish, download, install or change a catalog.
preview resolves exact dependencies and produces native payloads for server ingestion.
export-tool uses createToolAsset; prepared input is built publication + artifact URLs.
The app must validate native payloads before saving and deliver through API Gateway.
`;

async function json(filename) {
  const info=await lstat(filename);
  if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size>16*1024**2)throw new Error('Ordinary JSON file required, at most 16 MiB');
  const bytes=await readFile(filename);if(!Buffer.from(bytes.toString('utf8')).equals(bytes))throw new Error('UTF-8 JSON required');
  return JSON.parse(bytes.toString('utf8'));
}
async function main(args) {
  if(!args.length||args.length===1&&['--help','-h'].includes(args[0])){process.stdout.write(help);return;}
  const [command,directory='.',...ids]=args;
  if(command==='compare') {
    if(args.length!==3)throw new Error('compare requires previous and next indexes');
    assertIndexEvolution(await json(directory),await json(ids[0]));return {ok:true,immutableVersions:true};
  }
  if(command==='export-tool') {
    if(args.length!==3)throw new Error('export-tool requires prepared input and new output path');
    const result=createToolAsset(await json(directory));
    await writeFile(ids[0],serializeAsset(result),{flag:'wx',mode:0o644});
    return {ok:true,id:result.id,version:result.version,sha256:assetDigest(serializeAsset(result))};
  }
  if(!['validate','list','preview'].includes(command)||['validate','list'].includes(command)&&args.length>2||command==='preview'&&!ids.length)throw new Error(help);
  const loaded=await loadRepository(directory);
  if(command==='validate') {
    for(const record of loaded.assets)if(record.current)selectAssets(loaded.assets,[record.asset.id]);
    return {ok:true,schemaVersion:1,indexSha256:loaded.indexSha256,assets:loaded.assets.length,kinds:[...new Set(loaded.assets.map(item=>item.asset.kind))].sort()};
  }
  if(command==='list')return {ok:true,indexSha256:loaded.indexSha256,assets:loaded.assets.map(({asset,sha256,current})=>({id:asset.id,kind:asset.kind,version:asset.version,sha256,current,name:asset.card.name,license:asset.license.spdx,
    targets:[...new Set(downloadArtifacts(asset).map(item=>item.target).filter(Boolean))]}))};
  const selected=selectAssets(loaded.assets,ids),adapters={mcp:toToolPublication,plugin:toToolPublication,skill:toSkillCreate,model:toModelRecord,bridge:toBridgeRelease,agent:toAgentRecord};
  return {ok:true,dryRun:true,indexSha256:loaded.indexSha256,assets:selected.map(({asset,sha256,path,current})=>({id:asset.id,kind:asset.kind,version:asset.version,sha256,path,current,
    native:adapters[asset.kind](asset),serverSupply:downloadArtifacts(asset)}))};
}
try {const result=await main(process.argv.slice(2));if(result!==undefined)process.stdout.write(JSON.stringify(result,null,2)+'\n');}
catch(error){process.stderr.write(JSON.stringify({ok:false,error:error.message})+'\n');process.exitCode=1;}
