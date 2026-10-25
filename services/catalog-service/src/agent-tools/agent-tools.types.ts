import type {ChatMessage} from '../model-chat/chat.types';
import type {IChatContextSettings} from '../model-chat/chat-context';
import type {PoolClient} from 'pg';

export interface AgentToolGrant {
 protocol:'json-actions-v1'; rag:boolean;
 publicChats?:{modelId:string;expectedModelPin:string;consent:true;roomId?:string};
 systemRoles?:boolean;
}
export type AgentToolAction={action:'finish'}|{action:'rag_search';query:string}|{action:'rag_read';sourceId:string}
 |{action:'public_chat_search';query:string}|{action:'request_system_role';roleId:string;instruction:string};
export type AgentToolState='queued'|'dispatched'|'succeeded'|'failed'|'unknown'|'cancelled';
export interface AgentToolOwner {
 kind:'model-chat'|'project-chat';originId:string;turnId:string;recipientId:string;generation:string;
 ownerEmail:string;actorRole:string;projectId:string;agentId:string|null;modelId:string;modelPin:string;grant:AgentToolGrant;
}
export type AgentToolDb=Pick<PoolClient,'query'>;
export interface AgentToolStepRow {
 id:string;owner_kind:AgentToolOwner['kind'];origin_id:string;turn_id:string;recipient_id:string;generation:string;
 owner_email:string;actor_role:string;project_id:string;agent_id:string|null;model_id:string;model_pin:string;grant_snapshot:AgentToolGrant;
 sequence:number;action:string;input:Record<string,unknown>;input_hash:string;state:AgentToolState;
 output:unknown|null;reference:Record<string,unknown>|null;error:string|null;deadline_at:Date|string;created_at:Date|string;updated_at:Date|string;
}
export interface AgentToolScope {
 owner:AgentToolOwner;messages:ChatMessage[];settings:IChatContextSettings;signal:AbortSignal;
 assertCurrent(db?:AgentToolDb):Promise<void>;
 /** Final answer owners may transition a turn to done inside their authorized transaction. */
 assertAuthorized?(db?:AgentToolDb):Promise<void>;
 infer(messages:ChatMessage[],beforeInference:()=>Promise<void>):Promise<string>;
 execute(action:Exclude<AgentToolAction,{action:'finish'}>,step:AgentToolStepRow,reference:(value:Record<string,unknown>)=>Promise<void>):Promise<unknown>;
 observe?(action:Exclude<AgentToolAction,{action:'finish'}>,output:unknown):void|Promise<void>;
 present?(action:Exclude<AgentToolAction,{action:'finish'}>,output:unknown):Promise<unknown>;
}
export const AGENT_TOOL_LIMITS=Object.freeze({steps:3,outputBytes:32768,contextBytes:98304,deadlineMs:120000});
export interface AgentToolCapabilities {
 protocol:'json-actions-v1';available:boolean;reason?:string;
 rag:{available:boolean;reason?:string};publicChats:{available:boolean;models:Array<{id:string;name:string;pin:string;dimension:number}>;reason?:string};
 systemRoles:{available:boolean;reason?:string};mcp:{available:false;reason:string};limits:{steps:number;deadlineMs:number};
}
