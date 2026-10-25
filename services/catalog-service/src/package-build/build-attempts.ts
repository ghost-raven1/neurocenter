import {parseBuildDiagnostic} from '../../../shared/package-build-diagnostics.cjs';
import {BuildDiagnosticError} from './build-process';
import {agentHash,packageAgentRecipe,packageAgentReport} from './package-agent.recipe';
import {ConflictException} from '@nestjs/common';
import type {BuildConfiguration} from './package-build.model';
import type {PackageAgentService} from './package-agent.service';
import type {PackageAgentContext,PackageAgentRuntimeReport} from './package-agent.model';
import {assertRuntimeCandidate,type BuildRuntimeReport} from './build-runtime';

interface BuildAttemptContext {
    agent?:PackageAgentService;
    context:(attempt:number,feedback?:PackageAgentRuntimeReport)=>PackageAgentContext;
    authorize:()=>Promise<void>;
    build:(config:BuildConfiguration,attempt:number)=>Promise<string>;
    verify:(manifest:string,identity:string)=>Promise<BuildRuntimeReport>;
    record:(attempt:number,report:BuildRuntimeReport)=>Promise<void>;
    reset:()=>Promise<void>;
    identity:(attempt:number)=>string;
}
export interface VerifiedBuildAttempt {manifest:string;report:BuildRuntimeReport;identity:string}
const infrastructureFailures=new Set(['isolation-unavailable','no-host-artifact','configuration-required','integrity-failed','unsafe-environment','cleanup-failed','cancelled']);

/** One durable queue owner, bounded paid calls, and no publication of a failed or different candidate. */
export async function buildVerifiedAttempts(original:BuildConfiguration,context:BuildAttemptContext):Promise<VerifiedBuildAttempt> {
    if(original.agent&&!context.agent)throw new ConflictException('Агент «Упаковщик» недоступен. Создайте ручную сборку или повторите позже.');
    let config=original,feedback:PackageAgentRuntimeReport|undefined,failedRecipeHash:string|undefined;
    const attempts=original.agent?.maxAttempts??1;
    for(let attempt=1;attempt<=attempts;attempt++){
        await context.authorize();
        if(attempt>1)await context.reset();
        if(original.agent)config=await context.agent!.propose(config,context.context(attempt,feedback));
        if(failedRecipeHash&&failedRecipeHash===agentHash(packageAgentRecipe(config)))throw new ConflictException('Агент не изменил нерабочий рецепт сборки. Повтор остановлен.');
        failedRecipeHash=undefined;
        await context.authorize();
        let manifest:string;
        try{manifest=await context.build(config,attempt);}catch(error){
            const report=error instanceof BuildDiagnosticError?parseBuildDiagnostic(error.report,config.targets):undefined;
            // Only newly accepted v2 budgets may repair a classified source failure; unknown sends/infrastructure never retry.
            if(original.recipeVersion!==2||!original.agent||!report?.repairable||attempt>=attempts)throw error;
            feedback=packageAgentReport({passed:false,summary:'Сборка не завершена: '+report.stage,diagnostics:[report.reason],build:report});
            failedRecipeHash=agentHash(packageAgentRecipe(config));
            continue;
        }
        await context.authorize();
        const identity=context.identity(attempt),report=await context.verify(manifest,identity);
        await context.record(attempt,report);
        await context.authorize();
        feedback={passed:report.ok&&report.status==='passed',diagnostics:report.diagnostics.map(item=>item.message)};
        if(!feedback.passed&&(!original.agent||report.diagnostics.some(item=>infrastructureFailures.has(item.code))))
            throw new ConflictException(report.diagnostics[0]?.message??'Проверка запуска не пройдена. Пакет не опубликован.');
        if(original.agent){
            const review=await context.agent!.review(config,feedback,context.context(attempt));
            if(review.decision==='repair'){
                config=review.config;
                if(attempt<attempts)continue;
                throw new ConflictException('Лимит попыток Упаковщика исчерпан. Исправьте рецепт и создайте новую сборку.');
            }
        }
        await context.authorize();
        await assertRuntimeCandidate(manifest,report,identity);
        return {manifest,report,identity};
    }
    throw new ConflictException('Проверка запуска не пройдена. Пакет не опубликован.');
}
