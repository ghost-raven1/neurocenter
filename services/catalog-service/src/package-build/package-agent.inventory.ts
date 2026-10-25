import {reserveCapacity} from '../../../shared/capacity.cjs';
import {cleanBuildReason} from '../../../shared/package-build-diagnostics.cjs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {BadRequestException} from '@nestjs/common';
import type {BuildSourceInventory} from '../../../shared/package-build-plan.cjs';
import {builderScript,stagingLimit} from './build-process';
import type {BuildConfiguration} from './package-build.model';

const {loadBuildInspector:loadInspector}=createRequire(__filename)('../../../shared/package-build-loader.cjs') as {loadBuildInspector:(url:string)=>Promise<{inspectBuildSource:(config:BuildConfiguration,root:string)=>Promise<BuildSourceInventory>}>};

/** Called once for new accepted v2 work; old/replayed jobs keep their original interpretation. */
export async function pinBuildRecipe(config:BuildConfiguration,root:string,enabled:boolean):Promise<BuildConfiguration>{
    if(!enabled||!config.agent)return config;
    const {inspectBuildSource}=await loadInspector(path.join(path.dirname(builderScript()),'inspect-build-source.mjs'));
    const release=await reserveCapacity({resource:'runtime-artifacts',bytes:config.source.type==='files'?8*1024**2:stagingLimit,path:root});
    try{return {...config,recipeVersion:2,recipeInventory:await inspectBuildSource(config,root)};}
    catch(error){throw new BadRequestException(error instanceof Error?cleanBuildReason(error.message):'Не удалось проверить исходники автоматического рецепта.');}
    finally{release();}
}
