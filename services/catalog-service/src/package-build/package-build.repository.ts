import {parseBuildDiagnostic,type BuildDiagnostic} from '../../../shared/package-build-diagnostics.cjs';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {hostname} from 'node:os';
import type { Pool, PoolClient } from 'pg';
import type { BuildConfiguration, BuildResult, BuildRow, BuildState } from './package-build.model';
import {BuildCancelledError} from './build-cancellation';
import {configureBuildPublicationTransaction} from './publication-deadline';
import type {BuildRuntimeReport} from './build-runtime';

/** Очередь сборки и её проекция в «Операциях» фиксируются одной транзакцией. */
export class PackageBuildRepository {
    constructor(private readonly pool: Pool,private readonly taintedLease?:(client:PoolClient)=>void) {}
    /** Bounded public history remains readable when creation/inference flags are disabled. */
    async evidence(id:string){
        const runtime=await this.pool.query<{attempt:number;report:BuildRuntimeReport}>('SELECT attempt,report FROM tool_build_runtime_checks WHERE build_id=$1 ORDER BY attempt DESC LIMIT 1',[id]);
        const steps=await this.pool.query(`SELECT attempt,stage,state,recipe,diagnostics,error_code AS "errorCode",started_at AS "startedAt",finished_at AS "finishedAt"
            FROM tool_build_agent_steps WHERE build_id=$1 ORDER BY attempt,CASE stage WHEN 'propose' THEN 0 ELSE 1 END`,[id]);
        return {runtimeVerification:runtime.rows[0]?.report??null,runtimeVerificationAttempt:runtime.rows[0]?.attempt??null,agentSteps:steps.rows};
    }
    async agentTransaction<T>(lease:PoolClient,work:(client:PoolClient)=>Promise<T>):Promise<T>{return this.transaction(work,lease);}
    /** A new attempt cannot inherit the previous supervisor's reap proof. */
    async nextAttempt(id:string,nonce:string,lease:PoolClient):Promise<string>{
        return this.transaction(async client=>{
            const row=(await client.query<BuildRow>('SELECT * FROM tool_build_jobs WHERE id=$1 FOR UPDATE',[id])).rows[0];
            if(row?.state==='CANCELLING'||row?.state==='CANCELLED')throw new BuildCancelledError();
            if(row?.state!=='RUNNING'||row.execution_nonce!==nonce||row.publication_started_at)throw new ConflictException('Сборка потеряла владельца попытки.');
            const next=randomUUID();await client.query('UPDATE tool_build_jobs SET execution_nonce=$2,execution_started=false,updated_at=now() WHERE id=$1',[id,next]);return next;
        },lease);
    }
    async recordRuntime(id:string,nonce:string,attempt:number,report:BuildRuntimeReport,lease:PoolClient):Promise<void>{
        await this.transaction(async client=>{
            const row=(await client.query<BuildRow>('SELECT * FROM tool_build_jobs WHERE id=$1 FOR UPDATE',[id])).rows[0];
            if(row?.state==='CANCELLING'||row?.state==='CANCELLED')throw new BuildCancelledError();
            if(row?.state!=='RUNNING'||row.execution_nonce!==nonce||row.publication_started_at)throw new ConflictException('Проверка запуска потеряла владельца сборки.');
            await client.query('INSERT INTO tool_build_runtime_checks(build_id,attempt,execution_nonce,report) VALUES($1,$2,$3,$4::jsonb)',[id,attempt,nonce,report]);
        },lease);
    }
    /** Persist safe evidence while the exact queue owner still holds its lease, before staging cleanup. */
    async recordBuildDiagnostic(id:string,nonce:string,attempt:number,report:BuildDiagnostic,lease:PoolClient):Promise<void>{
        await this.transaction(async client=>{
            const row=(await client.query<BuildRow>('SELECT * FROM tool_build_jobs WHERE id=$1 FOR UPDATE',[id])).rows[0];
            if(row?.state==='CANCELLING'||row?.state==='CANCELLED')throw new BuildCancelledError();
            if(row?.state!=='RUNNING'||row.execution_nonce!==nonce||row.publication_started_at)throw new ConflictException('Диагностика потеряла владельца сборки.');
            const safe=parseBuildDiagnostic(report,row.config.targets);
            if(!safe||!Number.isSafeInteger(attempt)||attempt<1||attempt>3)throw new ConflictException('Некорректная диагностика сборки.');
            const evidence=[...(row.config.buildDiagnostics??[]),{attempt,report:safe}].slice(-3);
            await client.query("UPDATE tool_build_jobs SET config=jsonb_set(config,'{buildDiagnostics}',$2::jsonb),updated_at=now() WHERE id=$1",[id,JSON.stringify(evidence)]);
        },lease);
    }
    async existing(actor: string, key: string, fingerprint: string): Promise<BuildRow | undefined> {
        const {rows} = await this.pool.query<BuildRow>('SELECT * FROM tool_build_jobs WHERE actor=$1 AND request_key=$2', [actor, key]);
        if (rows[0] && rows[0].request_hash !== fingerprint) { throw new ConflictException('Ключ запроса уже использован для другой сборки.'); }
        if(!rows[0])await this.assertNotCancelled(this.pool,actor,key);
        return rows[0];
    }
    async get(id: string): Promise<BuildRow> {
        const {rows} = await this.pool.query<BuildRow>('SELECT * FROM tool_build_jobs WHERE id=$1', [id]);
        if (!rows[0]) { throw new NotFoundException('Сборка не найдена.'); }
        return rows[0];
    }
    async findByRequest(actor: string, key: string): Promise<BuildRow> {
        const {rows} = await this.pool.query<BuildRow>('SELECT * FROM tool_build_jobs WHERE actor=$1 AND request_key=$2', [actor, key]);
        if (!rows[0]) {throw new NotFoundException('Сборка по этому запросу ещё не найдена.');}
        return rows[0];
    }
    async enqueue(actor: string, key: string, fingerprint: string, config: BuildConfiguration, lease?: PoolClient,retain?: (client:PoolClient)=>Promise<void>): Promise<BuildRow> {
        return this.transaction(async client => {
            await client.query('SELECT pg_advisory_xact_lock(72465396)');
            const previous = await client.query<BuildRow>('SELECT * FROM tool_build_jobs WHERE actor=$1 AND request_key=$2', [actor, key]);
            if (previous.rows[0]) {
                if (previous.rows[0].request_hash !== fingerprint) { throw new ConflictException('Ключ запроса уже использован для другой сборки.'); }
                return previous.rows[0];
            }
            await this.assertNotCancelled(client,actor,key);
            if(retain)await retain(client);
            const pending = await client.query<{count: number}>("SELECT count(*)::int AS count FROM tool_build_jobs WHERE state IN ('QUEUED','RUNNING')");
            if ((pending.rows[0]?.count ?? 0) >= 10) { throw new ConflictException('В очереди уже 10 сборок. Дождитесь освобождения места в «Операциях» и повторите запрос.'); }
            const {rows} = await client.query<BuildRow>(`INSERT INTO tool_build_jobs(id,actor,request_key,request_hash,config,state,message)
                VALUES($1,$2,$3,$4,$5,'QUEUED','В очереди сборки. Начнём после предыдущих инструментов.') RETURNING *`, [randomUUID(), actor, key, fingerprint, config]);
            await this.operation(client, rows[0]);
            return rows[0];
        }, lease);
    }
    /** Единственный владелец запускает задания по порядку, сохраняя ожидающие при перезапуске. */
    async takeQueued(lease: PoolClient): Promise<BuildRow | undefined> {
        return this.transaction(async client => {
            const {rows} = await client.query<BuildRow>("SELECT * FROM tool_build_jobs WHERE state='QUEUED' ORDER BY created_at,id LIMIT 1 FOR UPDATE");
            if (!rows[0]) {return undefined;}
            await this.saveProgress(client, rows[0].id, 'RUNNING', 0, 'Подготовка сборки');
            return(await client.query<BuildRow>('UPDATE tool_build_jobs SET execution_nonce=$2,execution_host=$3,execution_pid=$4,execution_started=false WHERE id=$1 RETURNING *',[rows[0].id,randomUUID(),hostname(),process.pid])).rows[0];
        }, lease);
    }
    async progress(id: string, state: BuildState, percent: number, message: string, result?: BuildResult, error?: string): Promise<BuildRow> {
        return this.transaction(client => this.saveProgress(client, id, state, percent, message, result, error));
    }
    private async assertNotCancelled(db:Pick<Pool,'query'>,actor:string,key:string):Promise<void>{
        if((await db.query('SELECT 1 FROM tool_build_cancellations WHERE actor=$1 AND request_key=$2',[actor,key])).rows.length)
            throw new ConflictException('Этот запрос сборки отменён. Исходники сохранены; начните сборку новым запросом.');
    }
    /** The same short queue lock fences a lost POST against its durable cancellation intent. */
    async cancelRequest(actor:string,key:string,authorize:()=>Promise<void>):Promise<BuildRow|undefined>{
        return this.transaction(async client=>{
            await client.query('SELECT pg_advisory_xact_lock(72465396)');
            const {rows}=await client.query<BuildRow>('SELECT * FROM tool_build_jobs WHERE actor=$1 AND request_key=$2 FOR UPDATE',[actor,key]);
            await authorize();
            await client.query('INSERT INTO tool_build_cancellations(actor,request_key) VALUES($1,$2) ON CONFLICT DO NOTHING',[actor,key]);
            return rows[0]?this.cancelLocked(client,rows[0]):undefined;
        });
    }
    async cancel(actor:string,id:string,authorize:()=>Promise<void>):Promise<BuildRow>{
        return this.transaction(async client=>{
            await client.query('SELECT pg_advisory_xact_lock(72465396)');
            const {rows}=await client.query<BuildRow>('SELECT * FROM tool_build_jobs WHERE id=$1 AND actor=$2 FOR UPDATE',[id,actor]);
            if(!rows[0])throw new NotFoundException('Сборка не найдена.');
            await authorize();
            await client.query('INSERT INTO tool_build_cancellations(actor,request_key) VALUES($1,$2) ON CONFLICT DO NOTHING',[actor,rows[0].request_key]);
            return this.cancelLocked(client,rows[0]);
        });
    }
    private async cancelLocked(client:PoolClient,row:BuildRow):Promise<BuildRow>{
        if(row.publication_started_at||!['QUEUED','RUNNING'].includes(row.state))return row;
        const state=row.state==='QUEUED'?'CANCELLED':'CANCELLING';
        const message=state==='CANCELLED'?'Сборка отменена до запуска. Исходники сохранены.':'Останавливаем сборку и очищаем её временные файлы.';
        const {rows}=await client.query<BuildRow>('UPDATE tool_build_jobs SET state=$2,message=$3,error=NULL,updated_at=now() WHERE id=$1 RETURNING *',[row.id,state,message]);
        await this.operation(client,rows[0]);return rows[0];
    }
    /** This committed row fence must precede even a non-transactional native skill write. */
    async beginPublication(id:string,lease:PoolClient,authorize:()=>Promise<void>):Promise<void>{
        await this.transaction(async client=>{
            const {rows}=await client.query<BuildRow>('SELECT * FROM tool_build_jobs WHERE id=$1 FOR UPDATE',[id]);
            await authorize();
            if(rows[0]?.state==='CANCELLING'||rows[0]?.state==='CANCELLED')throw new BuildCancelledError();
            if(rows[0]?.state!=='RUNNING')throw new ConflictException('Сборка уже завершена.');
            await client.query('UPDATE tool_build_jobs SET publication_started_at=COALESCE(publication_started_at,now()),updated_at=now() WHERE id=$1',[id]);
        },lease);
    }
    /** A terminal trace needs the existing transition's committed acknowledgment. */
    async completeCancellation(id:string):Promise<boolean>{
        return this.transaction(async client=>{
            const {rows,rowCount}=await client.query<BuildRow>(`UPDATE tool_build_jobs SET state='CANCELLED',message='Сборка отменена. Исходники и опубликованные версии сохранены.',error=NULL,updated_at=now() WHERE id=$1 AND state='CANCELLING' AND publication_started_at IS NULL RETURNING *`,[id]);
            if(rows[0])await this.operation(client,rows[0]);
            return !!rowCount;
        });
    }
    /** A passive supervisor may start its builder only after this durable, lease-bound acknowledgment. */
    async markExecutionStarted(id:string,nonce:string,lease:PoolClient):Promise<void>{
        await this.transaction(async client=>{
            const row=(await client.query<BuildRow>('SELECT * FROM tool_build_jobs WHERE id=$1 FOR UPDATE',[id])).rows[0];
            if(row?.state==='CANCELLING'||row?.state==='CANCELLED')throw new BuildCancelledError();
            if(row?.state!=='RUNNING'||row.execution_nonce!==nonce)throw new ConflictException('Сборка потеряла владельца до запуска.');
            await client.query('UPDATE tool_build_jobs SET execution_started=true,updated_at=now() WHERE id=$1',[id]);
        },lease);
    }
    async cancellationCleanupFailed(id:string):Promise<void>{
        await this.transaction(async client=>{
            const {rows}=await client.query<BuildRow>(`UPDATE tool_build_jobs SET message='Сборщик остановлен; очистка временных файлов будет повторена.',error='Не удалось очистить временные файлы. Отмена ещё не завершена.',updated_at=now() WHERE id=$1 AND state='CANCELLING' RETURNING *`,[id]);
            if(rows[0])await this.operation(client,rows[0]);
        });
    }
    async cancellationAwaitingOwner(id:string):Promise<void>{
        await this.transaction(async client=>{
            const message='Ожидаем подтверждение остановки прежнего сборщика. Можно продолжить работу и запустить другую сборку.';
            const {rows}=await client.query<BuildRow>(`UPDATE tool_build_jobs SET message=$2,updated_at=now() WHERE id=$1 AND state='CANCELLING' AND error IS NULL AND message<>$2 RETURNING *`,[id,message]);
            if(rows[0])await this.operation(client,rows[0]);
        });
    }
    async stagesToClean(ids:string[]):Promise<BuildRow[]>{
        if(!ids.length)return[];
        return(await this.pool.query<BuildRow>("SELECT * FROM tool_build_jobs WHERE id=ANY($1::uuid[]) AND state IN ('FAILED','SUCCEEDED','CANCELLED','CANCELLING')",[ids])).rows;
    }
    async cancellationsWithoutStage(ids:string[]):Promise<BuildRow[]>{
        return(await this.pool.query<BuildRow>("SELECT * FROM tool_build_jobs WHERE state='CANCELLING' AND NOT(id=ANY($1::uuid[]))",[ids])).rows;
    }
    /** Карточка, аудит публикации и успешная сборка используют один внешний COMMIT. */
    async completeWithPublication(client: PoolClient, id: string, result: BuildResult): Promise<void> {
        await this.saveProgress(client, id, 'SUCCEEDED', 100, 'Инструмент опубликован. Его можно установить через мост.', result);
    }
    private async saveProgress(client: PoolClient, id: string, state: BuildState, percent: number, message: string, result?: BuildResult, error?: string): Promise<BuildRow> {
        const {rows} = await client.query<BuildRow>(`UPDATE tool_build_jobs SET state=$2,percent=$3,message=$4,result=$5,error=$6,updated_at=now()
                WHERE id=$1 AND state IN ('QUEUED','RUNNING') RETURNING *`, [id, state, percent, message, result ?? null, error ?? null]);
        if (!rows[0]) {
            const current=await client.query<BuildRow>('SELECT * FROM tool_build_jobs WHERE id=$1',[id]);
            if(['CANCELLING','CANCELLED'].includes(current.rows[0]?.state))throw new BuildCancelledError();
            throw new ConflictException('Сборка уже завершена или её прервал перезапуск сервера.');
        }
        await this.operation(client, rows[0]);
        return rows[0];
    }
    /** Вызывается только владельцем межпроцессного advisory lock: живую реплику не прерываем. */
    async failInterrupted(lease?: PoolClient): Promise<void> {
        await this.transaction(async client => {
            const {rows} = await client.query<BuildRow>(`UPDATE tool_build_jobs SET state='FAILED',message='Сборка прервана перезапуском сервера',
                error='Сервер перезапустился. Повторите сборку новым запросом; уже опубликованные карточки сохранены.',updated_at=now()
                WHERE state='RUNNING' RETURNING *`);
            for (const row of rows) { await this.operation(client, row); }
        }, lease);
    }
    private async operation(client: PoolClient, row: BuildRow): Promise<void> {
        const entry = JSON.stringify([{at: new Date().toISOString(), level: row.state === 'FAILED' ? 'ERROR' : 'INFO', message: row.message}]);
        await client.query(`INSERT INTO operations(operation_id,type,resource_type,resource_id,actor,state,percent,started_at,finished_at,error,log)
            VALUES($1,'BUILD','tool-build',$2,$3,$4,$5,CASE WHEN $4='QUEUED' THEN NULL ELSE now() END,
                CASE WHEN $4 IN ('QUEUED','RUNNING') THEN NULL ELSE now() END,$6,$7::jsonb)
            ON CONFLICT(operation_id) DO UPDATE SET state=EXCLUDED.state,percent=EXCLUDED.percent,error=EXCLUDED.error,
                started_at=COALESCE(operations.started_at,EXCLUDED.started_at),finished_at=EXCLUDED.finished_at,log=operations.log||EXCLUDED.log`,
        ['tool-build-' + row.id, row.id, row.actor, row.state==='CANCELLING'?'RUNNING':row.state, row.percent, row.error, entry]);
    }
    private async transaction<T>(work: (client: PoolClient) => Promise<T>, borrowedClient?: PoolClient): Promise<T> {
        const client = borrowedClient ?? await this.pool.connect();
        let tainted=false;
        try { await client.query('BEGIN'); await configureBuildPublicationTransaction(client); const result = await work(client); await client.query('COMMIT'); return result; }
        catch (error) {
            try{await client.query('ROLLBACK');}catch{tainted=true;if(borrowedClient){if(this.taintedLease)this.taintedLease(client);else client.release(true);}}
            throw error;
        }
        finally { if (!borrowedClient) {if(tainted)client.release(true);else client.release();} }
    }
}
