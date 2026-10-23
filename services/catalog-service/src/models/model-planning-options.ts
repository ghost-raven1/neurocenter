import type {PoolClient} from 'pg';
import type {IModel} from './model.types';

export interface ModelPlanningOptions {contextWindow?:number;maxOutputTokens?:number}

/** Codex's declared context capacity is a planning budget, never a num_ctx provider parameter. */
export async function modelPlanningOptions(db:Pick<PoolClient,'query'>,model:IModel):Promise<ModelPlanningOptions>{
    if(model.runtime==='device-codex'){
        const row=(await db.query<{options:ModelPlanningOptions}>(`SELECT expected_candidate->'options' AS options FROM model_device_connections
            WHERE model_id=$1 AND semantic_sha=$2 AND revoked_at IS NULL`,[model.id,model.verificationSha256??null])).rows[0];
        return {contextWindow:row?.options?.contextWindow};
    }
    const row=(await db.query<{options:ModelPlanningOptions}>('SELECT options FROM model_remote_connections WHERE model_id=$1 AND semantic_sha=$2 AND revoked_at IS NULL ORDER BY revision DESC LIMIT 1',[model.id,model.verificationSha256??null])).rows[0];
    return row?.options??{};
}
