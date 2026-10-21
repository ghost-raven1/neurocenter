import type {IAccessActor} from '../access/access.model';
import type {LearningAnalysisInput,LearningExperience} from '../../../shared/project-learning.cjs';

export type LearningAnalysisState='queued'|'running'|'completed'|'failed'|'unknown';
export interface LearningAnalysis {
 id:string;projectId:string;requestKey:string;state:LearningAnalysisState;modelId:string;modelPin:string;
 experienceIds:string[];sourceRevision:number;createdAt:string;updatedAt:string;startedAt:string|null;finishedAt:string|null;
 hypothesisIds:string[];error:{code:string;message:string}|null;
}
export interface AnalysisSnapshot {
 actor:IAccessActor;projectId:string;revision:number;experiences:LearningExperience[];
}
export interface AnalysisRow {
 id:string;project_id:string;request_key:string;mutation_key:string;request_hash:string;actor_email:string;actor_role:string;model_epoch:string;
 state:LearningAnalysisState;model_id:string;model_pin:string;source_revision:string|number;input:LearningAnalysisInput;
 experiences:LearningExperience[];hypothesis_ids:string[];error_code:string|null;error_message:string|null;
 worker_id:string|null;lease_until:Date|string|null;created_at:Date|string;updated_at:Date|string;
 started_at:Date|string|null;finished_at:Date|string|null;
}
const date=(value:Date|string):string=>new Date(value).toISOString();
/** Worker-only snapshots and actor identity never enter the browser job response. */
export function analysisView(row:AnalysisRow):LearningAnalysis {
 return {id:row.id,projectId:row.project_id,requestKey:row.request_key,state:row.state,modelId:row.model_id,modelPin:row.model_pin,
  experienceIds:row.input.experienceIds,sourceRevision:Number(row.source_revision),createdAt:date(row.created_at),updatedAt:date(row.updated_at),
  startedAt:row.started_at?date(row.started_at):null,finishedAt:row.finished_at?date(row.finished_at):null,hypothesisIds:row.hypothesis_ids,
  error:row.error_code?{code:row.error_code,message:row.error_message||'Анализ не завершён.'}:null};
}
