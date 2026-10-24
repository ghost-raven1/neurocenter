import {packagingPlatformLabels} from './platformLabels';
import type {NpmPackageMetadata,RepositoryMetadata} from './types';
import type {SourceUpload} from './uploadTypes';

const knownTargets=Object.keys(packagingPlatformLabels);

/** The browser offers only targets already understood by the build API. */
export function supportedBuildTargets(metadata?:NpmPackageMetadata|RepositoryMetadata,upload?:SourceUpload,entrypoint?:string):string[]{
    const declared=upload?upload.metadata?.choices.find(choice=>choice.entrypoint===entrypoint)?.targets??upload.metadata?.supportedTargets??[]:metadata?.supportedTargets??knownTargets;
    return [...new Set(declared.filter(target=>knownTargets.includes(target)))];
}

/** Stored requests retain their ordered selection; malformed data never becomes the default. */
export function validBuildTargets(value:unknown):value is string[]{
    return Array.isArray(value)&&value.length>0&&value.length<=8&&new Set(value).size===value.length&&value.every(target=>typeof target==='string'&&knownTargets.includes(target));
}

export function buildTargetsError(value:string[]|undefined,supported:string[]):string{
    if(value===undefined)return '';
    if(!value.length)return 'Выберите хотя бы одну платформу.';
    if(!validBuildTargets(value)||value.some(target=>!supported.includes(target)))return 'Выбранная платформа недоступна для этого источника. Проверьте выбор платформ.';
    return '';
}
