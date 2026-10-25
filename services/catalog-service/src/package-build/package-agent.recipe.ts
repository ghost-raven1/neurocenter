import {ConflictException} from '@nestjs/common';
import {createHash} from 'node:crypto';
import {portablePath} from '../../../shared/runtime-artifacts.cjs';
import {isSourceEntrypoint} from '../../../shared/source-entrypoint.cjs';
import type {BuildConfiguration} from './package-build.model';
import type {PackageAgentContext,PackageAgentRecipe,PackageAgentRuntimeReport} from './package-agent.model';

export const agentObject=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):agentObject(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
export const agentHash=(value:unknown):string=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

/** Only the launch declaration may vary; every source pin and publication target stays fixed. */
export function packageAgentSourceHash(config:BuildConfiguration):string {
    const {entrypoint:_entrypoint,args:_args,...source}=config.source as BuildConfiguration['source']&{args?:string[]};
    const {buildDiagnostics:_diagnostics,...identity}=config;
    return agentHash({...identity,source});
}
const argsOf=(config:BuildConfiguration):string[]=>config.source.type==='files'?[...(config.source.args??[])]:[];
export function packageAgentRecipe(config:BuildConfiguration):PackageAgentRecipe {
    return {entrypoint:config.source.entrypoint,...(config.source.type==='files'?{args:argsOf(config)}:{})};
}
interface RecipeChoices {entrypoints:string[];arguments:string[][]}
export function packageAgentChoices(original:BuildConfiguration,context:PackageAgentContext):RecipeChoices {
    if(original.kind==='skill')throw new ConflictException('Агент «Упаковщик» пока работает с MCP и плагинами.');
    const source=original.source,fixed=source.type==='upload'||source.type==='repository'&&!!(source.runtimeSource||source.release);
    const entrypoints=[...new Set([source.entrypoint,...context.candidates])];
    if(entrypoints.length>32||entrypoints.some(value=>typeof value!=='string'||value.length>256||!portablePath(value)||!fixed&&!isSourceEntrypoint(value)))
        throw new ConflictException('Агенту нужны до 32 проверенных файлов запуска закреплённого исходника.');
    const verified=source.type==='files'?entrypoints.filter(value=>source.files.some(file=>file.path===value&&file.content.trim())):entrypoints;
    if(verified.length!==entrypoints.length)throw new ConflictException('Файл запуска агента отсутствует в исходниках.');
    const argumentsList=source.type==='files'?[argsOf(original),[],...(context.argumentCandidates??[]).map(args=>[...args])]:[[]];
    if(argumentsList.length>10||argumentsList.some(args=>!Array.isArray(args)||args.length>16||args.some(arg=>typeof arg!=='string'||arg.length>256||/[\x00-\x1f\x7f]/.test(arg))))
        throw new ConflictException('Аргументы агента должны быть заранее проверены и ограничены.');
    if(argumentsList.some(args=>args.some(arg=>/(?:password|secret|token|authorization|credential|api[-_]?key)/i.test(arg))))
        throw new ConflictException('Аргументы с учётными данными нельзя передавать агенту. Настройте секреты после установки.');
    const choices={entrypoints:fixed?[source.entrypoint]:verified,arguments:[...new Map(argumentsList.map(args=>[JSON.stringify(args),args])).values()]};
    if(Buffer.byteLength(JSON.stringify(choices))>12000)throw new ConflictException('Слишком много вариантов рецепта. Сократите список файлов запуска и аргументов.');
    return choices;
}

/** Model text is data: exact JSON keys and trusted choices replace executable tools. */
export function parsePackageAgentRecipe(value:unknown,current:BuildConfiguration,original:BuildConfiguration,context:PackageAgentContext):BuildConfiguration {
    if(!agentObject(value)||Object.keys(value).some(key=>!['entrypoint','args'].includes(key))||typeof value.entrypoint!=='string')
        throw new ConflictException('Агент вернул некорректный рецепт. Нужен JSON с entrypoint и args.');
    const choices=packageAgentChoices(original,context),args=value.args===undefined?[]:value.args;
    if(!choices.entrypoints.includes(value.entrypoint)||!Array.isArray(args)||!choices.arguments.some(candidate=>JSON.stringify(candidate)===JSON.stringify(args)))
        throw new ConflictException('Агент предложил файл или аргументы вне проверенного закреплённого исходника.');
    if(current.source.type!=='files'&&value.args!==undefined)throw new ConflictException('Этот источник не поддерживает изменение аргументов.');
    if(packageAgentSourceHash(current)!==packageAgentSourceHash(original))throw new ConflictException('Агент не может менять исходник, платформы или цель публикации.');
    return {...current,source:{...current.source,entrypoint:value.entrypoint,...(current.source.type==='files'?{args:[...(args as string[])]}:{})}} as BuildConfiguration;
}

/** Runtime diagnostics are bounded and redacted before being sent back to a model. */
export function packageAgentReport(report:PackageAgentRuntimeReport):PackageAgentRuntimeReport {
    if(typeof report.passed!=='boolean'||report.diagnostics!==undefined&&(!Array.isArray(report.diagnostics)||report.diagnostics.some(value=>typeof value!=='string'))
        ||report.summary!==undefined&&typeof report.summary!=='string')throw new ConflictException('Нужен результат реальной проверки runtime.');
    const clean=(value:string)=>value.slice(0,4096).replace(/[\x00-\x1f\x7f]/g,' ')
        .replace(/https?:\/\/\S+/gi,'[url]').replace(/(?:Bearer\s+\S+|(?:password|secret|token|api[_-]?key)\s*[:=]\s*\S+)/gi,'[secret]')
        .replace(/(?:\/Users\/|\/home\/|[A-Z]:\\Users\\)[^\s:]+/gi,'[private-path]').slice(0,1000);
    return {passed:report.passed,...(report.summary?{summary:clean(report.summary)}:{}),...(report.diagnostics?{diagnostics:report.diagnostics.slice(0,6).map(clean)}:{})};
}
export function packageAgentRecipeAudit(config:BuildConfiguration):Record<string,unknown> {
    const recipe=packageAgentRecipe(config);
    return {entrypoint:recipe.entrypoint,argumentCount:recipe.args?.length??0,argsSha256:agentHash(recipe.args??[])};
}
export function packageAgentReportAudit(report?:PackageAgentRuntimeReport):Record<string,unknown> {
    return report?{passed:report.passed,diagnosticCount:report.diagnostics?.length??0,diagnosticsSha256:agentHash(report)}:{};
}
