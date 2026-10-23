import {ConflictException} from '@nestjs/common';
import {BuildCancelledError} from './build-cancellation';
import type {BuildConfiguration} from './package-build.model';
import type {PackageAgentContext,PackageAgentDb,PackageAgentInput,PackageAgentStage} from './package-agent.model';
import {PACKAGE_AGENT_MAX_CALLS} from './package-agent.model';
import {agentHash,packageAgentRecipeAudit,packageAgentSourceHash} from './package-agent.recipe';

interface OwnerRow {state:string;execution_nonce:string|null;actor:string;config:BuildConfiguration;publication_started_at:string|null}
/** All journal writes use the existing queue lease and the job's current owner nonce. */
export class PackageAgentJournal {
    constructor(private readonly context:PackageAgentContext,private readonly config:BuildConfiguration){}
    private async owner(db:PackageAgentDb):Promise<OwnerRow> {
        this.context.signal.throwIfAborted();
        const row=(await db.query<OwnerRow>('SELECT state,execution_nonce,actor,config,publication_started_at FROM tool_build_jobs WHERE id=$1 FOR UPDATE',[this.context.buildId])).rows[0];
        if(row?.state==='CANCELLING'||row?.state==='CANCELLED')throw new BuildCancelledError();
        if(row?.state!=='RUNNING'||row.execution_nonce!==this.context.executionNonce||row.actor!==this.context.actorEmail||row.publication_started_at)
            throw new ConflictException('Агент потерял владельца сборки. Новый запрос модели не отправлен.');
        if(packageAgentSourceHash(row.config)!==packageAgentSourceHash(this.config))throw new ConflictException('Параметры сборки изменились. Агент остановлен.');
        await this.context.authorize();this.context.signal.throwIfAborted();return row;
    }
    async assertOwner():Promise<void> {await this.context.transaction(async db=>{await this.owner(db);});}
    async start(stage:PackageAgentStage,agent:PackageAgentInput,input:unknown,diagnostics:Record<string,unknown>):Promise<BuildConfiguration> {
        return this.context.transaction(async db=>{
            const row=await this.owner(db);
            const previous=await db.query('SELECT 1 FROM tool_build_agent_steps WHERE build_id=$1 AND attempt=$2 AND stage=$3',[this.context.buildId,this.context.attempt,stage]);
            if(previous.rows.length)throw new ConflictException('Этот шаг агента уже запускался. Автоматический платный повтор запрещён; создайте новую сборку.');
            const count=await db.query<{count:number}>('SELECT count(*)::int AS count FROM tool_build_agent_steps WHERE build_id=$1',[this.context.buildId]);
            if(Number(count.rows[0]?.count??0)>=Math.min(PACKAGE_AGENT_MAX_CALLS,agent.maxAttempts*2))throw new ConflictException('Лимит обращений агента «Упаковщик» исчерпан.');
            await db.query(`INSERT INTO tool_build_agent_steps(build_id,execution_nonce,attempt,stage,state,model_id,model_pin,input_hash,recipe,diagnostics)
                VALUES($1,$2,$3,$4,'STARTED',$5,$6,$7,$8::jsonb,$9::jsonb)`,
            [this.context.buildId,this.context.executionNonce,this.context.attempt,stage,agent.modelId,agent.expectedModelPin,agentHash(input),packageAgentRecipeAudit(this.config),diagnostics]);
            return row.config;
        });
    }
    async finish(stage:PackageAgentStage,config?:BuildConfiguration,errorCode?:'inference-failed'|'invalid-response',decision?:'publish'|'repair'):Promise<void> {
        await this.context.transaction(async db=>{
            await this.owner(db);
            const result=await db.query(`UPDATE tool_build_agent_steps SET state=$5,recipe=$6::jsonb,error_code=$7,finished_at=now()
                WHERE build_id=$1 AND execution_nonce=$2 AND attempt=$3 AND stage=$4 AND state='STARTED' RETURNING build_id`,
            [this.context.buildId,this.context.executionNonce,this.context.attempt,stage,errorCode?'FAILED':'SUCCEEDED',
                {...packageAgentRecipeAudit(config??this.config),...(!errorCode?{decision:stage==='propose'?'recipe':decision}:{})},errorCode??null]);
            if(result.rowCount===0)throw new ConflictException('Шаг агента уже завершён или потерял владельца.');
        });
    }
}
