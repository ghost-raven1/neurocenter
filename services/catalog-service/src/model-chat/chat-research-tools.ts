import {ConflictException,ForbiddenException,HttpException,ServiceUnavailableException} from '@nestjs/common';
import type {Request} from 'express';
import type {IPackage} from '../catalog/bundle-package';
import {checkedProjectPackage,projectAssetColumns,type IProjectPinRow} from '../catalog/project-asset-pins';
import {normalizeRuntimeArtifacts} from '../../../shared/runtime-artifacts.cjs';
import {FeatureFlagError,readFeatures} from '../../../shared/feature-client.cjs';
import type {ModelsService} from '../models/models.service';
import type {ModelChatProjectContext} from './chat-project-context';
import type {ChatDb} from './chat.repository';
import type {ConversationRow} from './chat.types';
import type {ChatResearchRequest} from './chat-research.types';
import {RESEARCH_TOOL_NAMES} from './chat-research-client';

export const RESEARCH_LIMITS={stepsPerRecipient:6,externalCallsPerRound:16,toolOutputBytes:65536,gatheredTextBytes:98304,roundTimeoutMs:900000}as const;
export interface ResearchChoice {assetId:string;name:string;version:number;manifest:string;available:boolean;reason?:string}
export interface ResearchChoices {project:{available:boolean;reason?:string};external:ResearchChoice[];limits:typeof RESEARCH_LIMITS}

/** The catalogue approves the native package; a model cannot provide executable config or a new endpoint. */
export function assertResearchPackage(pkg:IPackage):void {
    const descriptor=pkg.config?.extra?.researchMcp as {adapter?:unknown;tools?:unknown}|undefined;
    if(pkg.schemaVersion!==5||pkg.plugin.kind!=='mcp'||pkg.config?.transport!=='stdio'||pkg.config.extra?.hostedMcp!==true
        ||!descriptor||descriptor.adapter!=='exa'||!Array.isArray(descriptor.tools)||descriptor.tools.length!==RESEARCH_TOOL_NAMES.length
        ||!RESEARCH_TOOL_NAMES.every(name=>(descriptor.tools as unknown[]).includes(name)))throw new ConflictException('Назначенный MCP не поддерживает разрешённый поиск и чтение внешних источников.');
    try {if(!normalizeRuntimeArtifacts(pkg.config.extra.runtimeArtifacts).length)throw new Error('missing');}
    catch {throw new ConflictException('Поисковый MCP не содержит проверенной серверной поставки. Обновите назначение проекта.');}
}

/** Exact project assignments are checked before each tool call and before committing its result. */
export class ChatResearchTools {
    constructor(private readonly models:ModelsService,private readonly projectContext:ModelChatProjectContext){}
    async choices(req:Request,row:ConversationRow):Promise<ResearchChoices> {
        if(!row.project_id)return {project:{available:false,reason:'Сначала выберите проект.'},external:[],limits:RESEARCH_LIMITS};
        await this.models.resolveProject(req,row.project_id,2);
        const [flags,overview,rows]=await Promise.all([this.flags(),this.projectContext.overview(req,row.project_id),this.rows(row.project_id)]);
        const enabled=flags.flags.research_tools&&flags.flags.model_chat;
        const external=rows.map(item=>{
            let reason:string|undefined,name='Поисковый MCP';
            try {const pkg=checkedProjectPackage(item);name=pkg.plugin.name;assertResearchPackage(pkg);}
            catch(error){reason=error instanceof ConflictException?error.message:'Не удалось проверить закреплённый MCP.';}
            if(!enabled)reason='Исследование выключено главным администратором.';
            else if(!flags.flags.tool_catalog)reason='Каталог инструментов выключен главным администратором.';
            return {assetId:item.asset_id,name,version:Number(item.asset_version??0),manifest:item.asset_manifest??'',available:!reason,...(reason?{reason}:{})};
        });
        await this.models.resolveProject(req,row.project_id,2);
        const reason=!enabled?'Исследование выключено главным администратором.':!flags.flags.project_search?'Поиск по проекту выключен главным администратором.'
            :overview.status!=='ready'?overview.message||'Подготовьте и синхронизируйте базу знаний проекта.':undefined;
        return {project:{available:!reason,...(reason?{reason}:{})},external,limits:RESEARCH_LIMITS};
    }
    async resolve(req:Request,row:ConversationRow,ref:NonNullable<ChatResearchRequest['external']>,db?:ChatDb):Promise<IPackage> {
        if(!row.project_id)throw new ForbiddenException('Поисковый MCP должен быть назначен проекту этого диалога.');
        await this.models.resolveProject(req,row.project_id,2);
        const item=(await (db??this.models.pool).query<IProjectPinRow>(`SELECT ${projectAssetColumns} FROM project_assets WHERE project_id=$1 AND asset_kind='mcp' AND asset_id=$2`,[row.project_id,ref.assetId])).rows[0];
        if(!item||item.asset_version!==ref.version||item.asset_manifest!==ref.manifest)throw new ConflictException('Назначение или версия поискового MCP изменились. Выберите актуальный источник для нового сообщения.');
        const pkg=checkedProjectPackage(item);assertResearchPackage(pkg);await this.models.resolveProject(req,row.project_id,2);return pkg;
    }
    private async rows(projectId:string):Promise<IProjectPinRow[]> {
        const result=await this.models.pool.query<IProjectPinRow>(`SELECT ${projectAssetColumns} FROM project_assets WHERE project_id=$1 AND asset_kind='mcp'
            AND pin_snapshot->'package'->'config'->'extra'->'researchMcp'->>'adapter'='exa' ORDER BY asset_id LIMIT 101`,[projectId]);
        if(result.rows.length>100)throw new ServiceUnavailableException('В проекте слишком много поисковых MCP. Сократите список назначений и повторите.');
        return result.rows;
    }
    private async flags() {
        try{return await readFeatures();}
        catch(error){if(error instanceof FeatureFlagError)throw new HttpException({code:error.code,message:error.message},error.status);throw error;}
    }
}
