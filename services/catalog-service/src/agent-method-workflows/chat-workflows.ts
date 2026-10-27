import {NotFoundException} from '@nestjs/common';
import {agentMethodWorkflowAgentIdentity,normalizeAgentMethodWorkflowPayload,normalizeAgentMethodWorkflowResult} from '../../../shared/agent-method-workflow.cjs';
import type {ProjectChatActor} from '../project-chat/project-chat.policy';
import type {ProjectChatDb} from '../project-chat/project-chat.types';
import type {ProjectChatMethodWorkflow,ProjectChatMethodWorkflowPage,MethodChatPublication} from './chat-workflows.types';

interface ReceiptRow {id:string;source_message_id:string;email:string;payload:unknown;state:ProjectChatMethodWorkflow['state'];percent:number|null;
    created_at:Date|string;started_at:Date|string|null;updated_at:Date|string;publication_state:MethodChatPublication;public_result:unknown}
const instant=(value:Date|string)=>new Date(value).toISOString();
const columns='job.id,link.source_message_id,job.email,job.payload,job.state,job.percent,job.created_at,job.started_at,job.updated_at,link.publication_state,link.public_result';
function receipt(row:ReceiptRow,actor:ProjectChatActor):ProjectChatMethodWorkflow {
    const payload=normalizeAgentMethodWorkflowPayload(row.payload);
    if(!payload.agent)throw new Error('Linked workflow requires an accepted project agent.');
    return {jobId:row.id,workflowId:payload.workflowId,method:payload.method,agent:agentMethodWorkflowAgentIdentity(payload.agent),state:row.state,percent:row.percent,
        createdAt:instant(row.created_at),startedAt:row.started_at?instant(row.started_at):null,updatedAt:instant(row.updated_at),publicationState:row.publication_state,
        canCancel:row.email===actor.email&&actor.level>0&&['queued','running','reconciling'].includes(row.state),
        ...(row.publication_state==='published'&&row.public_result?{result:normalizeAgentMethodWorkflowResult(row.public_result,payload)}:{})};
}
function page(rows:ReceiptRow[],limit:number,actor:ProjectChatActor):ProjectChatMethodWorkflowPage {
    const items=rows.slice(0,limit).map(row=>receipt(row,actor)),hasMore=rows.length>limit;
    return {items,hasMore,nextCursor:hasMore?items.at(-1)!.jobId:null};
}

/** Initial history carries only the newest receipt per source and a source-scoped continuation. */
export async function projectChatMethodWorkflows(db:ProjectChatDb,projectId:string,roomId:string,messageIds:string[],actor:ProjectChatActor):Promise<Map<string,ProjectChatMethodWorkflowPage>> {
    const grouped=new Map<string,ReceiptRow[]>();
    if(!messageIds.length)return new Map();
    const {rows}=await db.query<ReceiptRow>(`SELECT latest.* FROM unnest($3::uuid[]) AS source(id) CROSS JOIN LATERAL (
        SELECT ${columns} FROM project_chat_method_workflows link JOIN bridge_jobs job ON job.id=link.job_id
        WHERE link.project_id=$1 AND link.room_id=$2 AND link.source_message_id=source.id ORDER BY link.created_at DESC,link.job_id DESC LIMIT 2) latest`,[projectId,roomId,messageIds]);
    for(const row of rows){const current=grouped.get(row.source_message_id)??[];current.push(row);grouped.set(row.source_message_id,current);}
    return new Map([...grouped].map(([source,rows])=>[source,page(rows,1,actor)]));
}

/** A foreign cursor cannot enumerate another room or source; timestamp text preserves PostgreSQL precision. */
export async function projectChatMethodWorkflowPage(db:ProjectChatDb,projectId:string,roomId:string,messageId:string,actor:ProjectChatActor,before?:string,limit=8):Promise<ProjectChatMethodWorkflowPage> {
    let cursor:string|null=null;
    if(before){
        const row=(await db.query<{at:string}>(`SELECT link.created_at::text AS at FROM project_chat_method_workflows link JOIN bridge_jobs job ON job.id=link.job_id
            WHERE link.project_id=$1 AND link.room_id=$2 AND link.source_message_id=$3 AND job.id=$4`,[projectId,roomId,messageId,before])).rows[0];
        if(!row)throw new NotFoundException('Квитанция задачи не найдена в этом сообщении.');
        cursor=row.at;
    }
    const {rows}=await db.query<ReceiptRow>(`SELECT ${columns} FROM project_chat_method_workflows link JOIN bridge_jobs job ON job.id=link.job_id
        WHERE link.project_id=$1 AND link.room_id=$2 AND link.source_message_id=$3
        AND ($4::timestamptz IS NULL OR (link.created_at,link.job_id)<($4::timestamptz,$5::text)) ORDER BY link.created_at DESC,link.job_id DESC LIMIT $6`,[projectId,roomId,messageId,cursor,before??null,limit+1]);
    return page(rows,limit,actor);
}
