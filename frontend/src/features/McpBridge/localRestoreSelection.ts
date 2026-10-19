import type { IBridgeInstallation, IBridgeJobDraft } from './api';
import type { ILocalChangeFile, ILocalChangePlan } from './operationTypes';
import { installedTuple } from './operationHelpers';

export interface IRestoreSelection {
    context:string; recoveryId:string; fullFiles:ILocalChangeFile[]; paths:string[]; preparedPaths:string[];
    plan:ILocalChangePlan; confirmed:boolean;
}
const pathsKey=(paths:string[])=>JSON.stringify([...paths].sort());

/** Первый полный список сохраняется при подготовке подмножества: исключённые пути можно вернуть в выбор. */
export function receiveRestorePreview(previous:IRestoreSelection|undefined, plan:ILocalChangePlan, context:string, recoveryId:string,
    requestedPaths?:string[]):IRestoreSelection {
    const preparedPaths=plan.files.map(file=>file.path);
    if (requestedPaths && pathsKey(preparedPaths)!==pathsKey(requestedPaths)) { throw new Error('Состав файлов изменился. Выберите вариант и подготовьте полное сравнение заново.'); }
    const retain=!!requestedPaths && previous?.context===context && previous.recoveryId===recoveryId;
    return {context,recoveryId,fullFiles:retain ? previous.fullFiles : plan.files,paths:[...preparedPaths],preparedPaths,
        plan,confirmed:false};
}
/** Любое изменение галочек аннулирует согласие и требует плана для точного нового набора. */
export function selectRestorePaths(state:IRestoreSelection, paths:string[]):IRestoreSelection {
    if (new Set(paths).size!==paths.length || paths.some(path=>!state.fullFiles.some(file=>file.path===path))) { throw new Error('Выбран неизвестный путь восстановления.'); }
    return {...state,paths:[...paths],confirmed:false};
}
export function restoreSelectionPrepared(state:IRestoreSelection|undefined, context:string):boolean {
    return !!state && state.context===context && state.paths.length>0 && pathsKey(state.paths)===pathsKey(state.preparedPaths)
        && pathsKey(state.paths)===pathsKey(state.plan.files.map(file=>file.path));
}
export function restoreSelectionCanApply(state:IRestoreSelection|undefined, context:string):boolean {
    return restoreSelectionPrepared(state,context) && state?.confirmed===true;
}
/** Пустой или посторонний набор не отправляется даже при программном вызове обработчика. */
export function prepareSelectedRestore(item:IBridgeInstallation,state:IRestoreSelection,context:string):{input:IBridgeJobDraft;selection:IRestoreSelection} {
    if (state.context!==context || !state.paths.length || new Set(state.paths).size!==state.paths.length || state.paths.some(path=>!state.fullFiles.some(file=>file.path===path))) {
        throw new Error('Выберите хотя бы один файл в актуальном сравнении.');
    }
    return {input:{kind:'prepare-local-restore',...installedTuple(item),recoveryId:state.recoveryId,restorePaths:[...state.paths]},selection:{...state,confirmed:false}};
}
