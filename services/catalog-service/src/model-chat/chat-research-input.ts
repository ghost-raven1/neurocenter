import {BadRequestException} from '@nestjs/common';
import type {ChatResearchRequest} from './chat-research.types';
import {chatResearchRequest} from './chat-research.repository';

/** Explicit per-message consent pins one project MCP; retry never accepts replacement settings. */
export function researchRequest(raw:unknown,projectId:string|null):ChatResearchRequest|null {
    if(raw===undefined||raw===null)return null;
    if(!projectId)throw new BadRequestException('Для исследования выберите проект и назначенные ему источники.');
    return chatResearchRequest(raw);
}
