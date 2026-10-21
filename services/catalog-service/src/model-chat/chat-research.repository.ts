import {BadRequestException,ConflictException,NotFoundException} from '@nestjs/common';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {Pool} from 'pg';
import type {ChatDb} from './chat.repository';
import {chatUuid} from './chat-validation';
import type {ChatResearchHistory,ChatResearchRequest,ChatResearchStep,ChatResearchStepSummary,FinishResearchStep,StartResearchStep} from './chat-research.types';
interface StepRow {id:string;conversation_id:string;turn_id:string;response_id:string|null;request_id:string;attempt:number;sequence:number;kind:ChatResearchStep['kind'];status:ChatResearchStep['status'];input:Record<string,unknown>;output:string;sources:unknown[];error:string|null;output_bytes:number;created_at:Date;updated_at:Date}
const columns='id,conversation_id,turn_id,response_id,request_id,attempt,sequence,kind,status,error,octet_length(output) AS output_bytes,created_at,updated_at';
const kinds=new Set(['planner','project_search','project_read','external_search','external_fetch']);
const keys=new Set(['query','sourceId','path','startLine','endLine','tool','arguments','modelId','modelPin']);
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const summary=(row:StepRow):ChatResearchStepSummary=>({id:row.id,conversationId:row.conversation_id,turnId:row.turn_id,responseId:row.response_id,requestId:row.request_id,attempt:row.attempt,sequence:row.sequence,kind:row.kind,status:row.status,error:row.error,outputBytes:Number(row.output_bytes),createdAt:new Date(row.created_at).toISOString(),updatedAt:new Date(row.updated_at).toISOString()});
const full=(row:StepRow):ChatResearchStep=>({...summary(row),input:row.input,output:row.output,sources:row.sources});
/** Canonical immutable consent lists only actual requested sources, never provider credentials. */
export function chatResearchRequest(raw:unknown):ChatResearchRequest{
 if(!object(raw)||Object.keys(raw).some(key=>!['project','external'].includes(key))||typeof raw.project!=='boolean'||!raw.project&&!raw.external)throw new BadRequestException('Выберите источник исследования.');
 let external:ChatResearchRequest['external'];
 if(raw.external!==undefined){const value=raw.external;if(!object(value)||Object.keys(value).sort().join(',')!=='assetId,manifest,version'||typeof value.assetId!=='string'||!value.assetId.trim()||value.assetId.length>256||/[\u0000-\u001f\u007f]/.test(value.assetId)||!Number.isSafeInteger(value.version)||Number(value.version)<1||Number(value.version)>999999999999999||typeof value.manifest!=='string'||!/^[a-f0-9]{64}$/.test(value.manifest))throw new BadRequestException('Выберите точную версию инструмента исследования.');external={assetId:value.assetId,version:Number(value.version),manifest:value.manifest};}
 return {project:raw.project,...external?{external}:{}};
}
function stepInput(raw:unknown):Record<string,unknown>{
 if(!object(raw)||Object.keys(raw).some(key=>!keys.has(key)))throw new BadRequestException('Некорректные параметры шага исследования.');
 let value:Record<string,unknown>;try{const json=JSON.stringify(raw);if(Buffer.byteLength(json)>8128)throw new Error();value=JSON.parse(json);}catch{throw new BadRequestException('Параметры шага превышают безопасный размер.');}
 for(const [key,item]of Object.entries(value)){if(key==='arguments'){
   const search=value.tool==='web_search_exa',fetch=value.tool==='web_fetch_exa';
   if(!object(item)||!search&&!fetch||Object.keys(item).some(name=>!(search?['query','objective','numResults']:['urls','maxCharacters']).includes(name)))throw new BadRequestException('Инструмент получил неподдерживаемые параметры.');
   if(search&&(['query','objective'].some(name=>typeof item[name]!=='string'||!(item[name] as string).trim()||(item[name] as string).length>2048||(item[name] as string).includes('\0'))||item.numResults!==undefined&&(!Number.isSafeInteger(item.numResults)||Number(item.numResults)<1||Number(item.numResults)>10)))throw new BadRequestException('Некорректный поисковый запрос.');
   if(fetch&&(!Array.isArray(item.urls)||!item.urls.length||item.urls.length>5||item.urls.some(url=>typeof url!=='string'||!url||url.length>2048||url.includes('\0'))||item.maxCharacters!==undefined&&(!Number.isSafeInteger(item.maxCharacters)||Number(item.maxCharacters)<1||Number(item.maxCharacters)>10000)))throw new BadRequestException('Некорректный запрос страниц.');
  }else if(['startLine','endLine'].includes(key)){if(!Number.isSafeInteger(item)||Number(item)<1)throw new BadRequestException('Некорректный диапазон строк.');}else if(typeof item!=='string'||item.length>4096||item.includes('\0'))throw new BadRequestException('Некорректный параметр шага.');}
 return value;
}
/** All methods run inside the caller's owned transaction, retaining fresh actor/project/model authorization. */
export class ChatResearchRepository {
 constructor(readonly pool:Pool){}
 /** Batch history shows the latest explicit attempt per recipient only; immutable older receipts remain available by scoped ID. */
 async list(db:ChatDb,conversationId:string,turnIds:string[]):Promise<ChatResearchStepSummary[]>{
  chatUuid(conversationId);if(turnIds.length>50)throw new BadRequestException('Слишком большая страница истории.');turnIds.forEach(chatUuid);if(!turnIds.length)return [];
  const {rows}=await db.query<StepRow>(`SELECT ${columns.split(',').map(column=>column==='octet_length(output) AS output_bytes'?'octet_length(s.output) AS output_bytes':'s.'+column).join(',')} FROM model_chat_research_steps s WHERE s.conversation_id=$1 AND s.turn_id=ANY($2::uuid[]) AND ((s.response_id IS NULL AND s.request_id=(SELECT t.request_id FROM model_chat_turns t WHERE t.id=s.turn_id)) OR (s.response_id IS NOT NULL AND s.request_id=(SELECT r.request_id FROM model_chat_agent_responses r WHERE r.id=s.response_id))) ORDER BY s.turn_id,s.attempt,s.sequence,s.id`,[conversationId,turnIds]);return rows.map(summary);
 }
 async get(db:ChatDb,conversationId:string,id:string):Promise<ChatResearchStep>{chatUuid(conversationId);chatUuid(id);const {rows}=await db.query<StepRow>(`SELECT *,octet_length(output) AS output_bytes FROM model_chat_research_steps WHERE conversation_id=$1 AND id=$2`,[conversationId,id]);if(!rows[0])throw new NotFoundException('Шаг исследования не найден.');return full(rows[0]);}
 /** Explicit bounded pages expose every immutable attempt without loading private tool outputs into history lists. */
 async history(db:ChatDb,conversationId:string,turnId:string,options:{before?:string;limit?:number}={}):Promise<ChatResearchHistory>{
  chatUuid(conversationId);chatUuid(turnId);if(options.before!==undefined)chatUuid(options.before);const limit=options.limit??50;
  if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new BadRequestException('Размер страницы исследования: от 1 до 100 шагов.');
  if(!(await db.query('SELECT 1 FROM model_chat_turns WHERE conversation_id=$1 AND id=$2 AND removed_at IS NULL',[conversationId,turnId])).rowCount)throw new NotFoundException('Сообщение не найдено.');
  if(options.before&&!(await db.query('SELECT 1 FROM model_chat_research_steps WHERE conversation_id=$1 AND turn_id=$2 AND id=$3',[conversationId,turnId,options.before])).rowCount)throw new NotFoundException('Курсор исследования не найден.');
  const {rows}=await db.query<StepRow>(`SELECT ${columns} FROM model_chat_research_steps WHERE conversation_id=$1 AND turn_id=$2
   AND ($3::uuid IS NULL OR (created_at,id)<(SELECT created_at,id FROM model_chat_research_steps WHERE conversation_id=$1 AND turn_id=$2 AND id=$3))
   ORDER BY created_at DESC,id DESC LIMIT $4`,[conversationId,turnId,options.before??null,limit+1]);
  const items=rows.slice(0,limit).map(summary),hasMore=rows.length>limit;return {items,history:{hasMore,nextCursor:hasMore?items.at(-1)!.id:null}};
 }
 async start(db:ChatDb,input:StartResearchStep):Promise<ChatResearchStep>{
  const {conversationId,turnId,requestId}=input;[conversationId,turnId,requestId].forEach(chatUuid);if(input.responseId)chatUuid(input.responseId);
  if(!Number.isSafeInteger(input.sequence)||input.sequence<1||input.sequence>6||!kinds.has(input.kind))throw new BadRequestException('Исследование ограничено шестью шагами на участника.');const data=stepInput(input.input);
  const {rows}=await db.query<{status:string;request_id:string;request_ids:string[];lease_until:Date;removed_at:Date|null;research_request:unknown}>('SELECT status,request_id,request_ids,lease_until,removed_at,research_request FROM model_chat_turns WHERE id=$1 AND conversation_id=$2 FOR UPDATE',[turnId,conversationId]),parent=rows[0],attempt=parent?parent.request_ids.indexOf(requestId)+1:0;
  if(!parent||!attempt||!parent.research_request)throw new ConflictException('Сообщение не разрешает это исследование.');
  const prior=(await db.query<StepRow>('SELECT *,octet_length(output) AS output_bytes FROM model_chat_research_steps WHERE turn_id=$1 AND response_id IS NOT DISTINCT FROM $2::uuid AND attempt=$3 AND sequence=$4',[turnId,input.responseId??null,attempt,input.sequence])).rows[0];
  if(prior){if(prior.kind!==input.kind||!isDeepStrictEqual(prior.input,data))throw new ConflictException('Этот шаг уже закреплён за другой операцией.');if(prior.status!=='pending')return full(prior);}
  if(parent.status!=='pending'||parent.request_id!==requestId||parent.removed_at||new Date(parent.lease_until).getTime()<=Date.now())throw new ConflictException('Исследование остановлено или передано другому запросу.');
  if(input.responseId){const recipient=(await db.query('SELECT 1 FROM model_chat_agent_responses WHERE id=$1 AND turn_id=$2 AND conversation_id=$3 AND status=\'pending\' AND request_id=$4 FOR UPDATE',[input.responseId,turnId,conversationId,requestId])).rowCount;if(!recipient)throw new ConflictException('Участник больше не ожидает этот ответ.');}
  if(prior)return full(prior);
  const previous=await db.query<{count:number;pending:number}>('SELECT count(*)::int AS count,count(*) FILTER(WHERE status=\'pending\')::int AS pending FROM model_chat_research_steps WHERE turn_id=$1 AND response_id IS NOT DISTINCT FROM $2::uuid AND attempt=$3',[turnId,input.responseId??null,attempt]);
  if(previous.rows[0].pending||previous.rows[0].count+1!==input.sequence)throw new ConflictException('Предыдущий шаг ещё выполняется или порядок шагов изменился.');
  const result=await db.query<StepRow>('INSERT INTO model_chat_research_steps(id,conversation_id,turn_id,response_id,request_id,attempt,sequence,kind,input) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) RETURNING *,octet_length(output) AS output_bytes',[randomUUID(),conversationId,turnId,input.responseId??null,requestId,attempt,input.sequence,input.kind,JSON.stringify(data)]);return full(result.rows[0]);
 }
 async finish(db:ChatDb,input:FinishResearchStep):Promise<ChatResearchStep>{
  chatUuid(input.id);chatUuid(input.requestId);if(!['done','failed','cancelled'].includes(input.status))throw new BadRequestException('Некорректный результат шага.');
  const output=input.output??'',sources=input.sources??[],error=input.error??null;
  if(typeof output!=='string'||output.includes('\0')||Buffer.byteLength(output)>65536||!Array.isArray(sources)||sources.length>32||Buffer.byteLength(JSON.stringify(sources))>60000||error!==null&&(typeof error!=='string'||error.length>512||error.includes('\0'))||input.status==='done'&&error!==null)throw new BadRequestException('Результат шага превышает допустимый размер или имеет неверный формат.');
  const prior=(await db.query<StepRow>('SELECT *,octet_length(output) AS output_bytes FROM model_chat_research_steps WHERE id=$1 AND request_id=$2 FOR UPDATE',[input.id,input.requestId])).rows[0];if(!prior)throw new NotFoundException('Шаг исследования не найден.');
  if(prior.status!=='pending'){if(prior.status===input.status&&prior.output===output&&isDeepStrictEqual(prior.sources,sources)&&prior.error===error)return full(prior);throw new ConflictException('Результат шага уже сохранён.');}
  const result=await db.query<StepRow>(`UPDATE model_chat_research_steps s SET status=$3,output=$4,sources=$5::jsonb,error=$6,updated_at=now(),finished_at=now() WHERE s.id=$1 AND s.request_id=$2 AND s.status='pending'
   AND EXISTS(SELECT 1 FROM model_chat_turns t WHERE t.id=s.turn_id AND t.status='pending' AND t.request_id=s.request_id AND t.lease_until>now() AND t.removed_at IS NULL)
   AND (s.response_id IS NULL OR EXISTS(SELECT 1 FROM model_chat_agent_responses r WHERE r.id=s.response_id AND r.status='pending' AND r.request_id=s.request_id)) RETURNING s.*,octet_length(s.output) AS output_bytes`,[input.id,input.requestId,input.status,output,JSON.stringify(sources),error]);
  if(!result.rows[0])throw new ConflictException('Исследование остановлено. Уже сохранённые результаты доступны в истории.');return full(result.rows[0]);
 }
 async cancelUnfinished(db:ChatDb,conversationId:string,turnId:string,requestId:string):Promise<number>{[conversationId,turnId,requestId].forEach(chatUuid);return (await db.query("UPDATE model_chat_research_steps SET status='cancelled',error='Исследование остановлено.',finished_at=now(),updated_at=now() WHERE conversation_id=$1 AND turn_id=$2 AND request_id=$3 AND status='pending'",[conversationId,turnId,requestId])).rowCount??0;}
}
