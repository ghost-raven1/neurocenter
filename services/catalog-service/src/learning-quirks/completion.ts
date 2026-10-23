import {ConflictException} from '@nestjs/common';
import {isDeepStrictEqual} from 'node:util';
import type {PoolClient} from 'pg';
import type {DeviceCompletion} from '../devices/device-completion';
import {recordDeviceOperation} from '../devices/device-operations';
import {assertQuirksJobResult,LEARNING_QUIRKS_KIND} from './learning-quirks-jobs';

/** Receipt delivery records reported experience progress without reapplying or approving it. */
export async function completeLearningQuirks(db:PoolClient,job:{id:string;kind:string;email:string;project_id:string|null;state:string;result?:unknown},input:DeviceCompletion){
 if(job.kind!==LEARNING_QUIRKS_KIND)return;
 assertQuirksJobResult(input.result,input.state==='failed');
 if(job.result){if(!isDeepStrictEqual(job.result,input.result))throw new ConflictException('Квитанция кварков уже сохранена иначе.');return {ok:true,repeated:true};}
 if(!['running','reconciling','cancelled','failed'].includes(job.state))throw new ConflictException('Мост не принимал это задание сбора кварков.');
 const state=job.state==='cancelled'?'cancelled':input.state;
 const message=state==='cancelled'?'Сбор остановлен; квитанция принятого опыта сохранена.':input.state==='succeeded'?'Кварки сохранены как сообщённый опыт. Принятие знаний требует проверки человека.':'Сохранена часть сообщённого опыта. Повтор безопасен.';
 await db.query('UPDATE bridge_jobs SET state=$2,percent=$3,message=$4,result=$5::jsonb,updated_at=now() WHERE id=$1',[job.id,state,input.state==='succeeded'?100:0,message,JSON.stringify(input.result)]);
 await recordDeviceOperation(db,job,state.toUpperCase(),input.state==='succeeded'?100:0,message);
 return {ok:true,repeated:false};
}
