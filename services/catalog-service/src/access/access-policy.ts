import {allowSystemRoleRoute} from '../system-roles/system-role.access';
import { canReadCommon, IAccessClaims, projectLevel } from './access.model';
import { canonicalAccessRoute } from '../../../shared/access-route.cjs';
import {allowLearningRoute} from './learning-access-policy';
import {allowAgentReadinessRoute} from '../agent-readiness/agent-readiness.access';

export interface IAccessRequest { method: string; path: string; query?: Record<string, unknown>; body?: Record<string, unknown> }

/** Проверяет действие и область проекта; неизвестные маршруты запрещены. */
export function allowRequest(claims: IAccessClaims, activeRole: string, request: IAccessRequest): boolean {
    if (!claims.userRoles.includes(activeRole)) { return false; }
    const main = activeRole === 'Главный админ';
    const common = canReadCommon(claims,activeRole);
    const read = ['GET','HEAD'].includes(request.method.toUpperCase());
    const route = canonicalAccessRoute(request.path);
    if (route === undefined) { return false; }
    const body = request.body ?? {};
    const verb = request.method.toUpperCase();
    const systemRole = allowSystemRoleRoute(activeRole, verb, route);
    if (typeof systemRole === 'boolean') return systemRole;
    if(route==='/api/chat-presence/session')return verb==='PUT';
    // Executors additionally check fresh target ACL, authorship and expected version.
    if(route==='/api/help')return read;
    if(/^\/api\/help\/[a-z0-9][a-z0-9-]{0,79}$/.test(route))return read||main&&verb==='PUT';
    if(route==='/api/discussions')return read;
    if(route==='/api/discussions/comments'||route==='/api/discussions/attachments')return verb==='POST';
    if(/^\/api\/discussions\/comments\/[a-f0-9-]{36}$/.test(route))return read||['PATCH','DELETE'].includes(verb);
    if(/^\/api\/discussions\/attachments\/[a-f0-9-]{36}$/.test(route))return verb==='DELETE';
    if(/^\/api\/discussions\/attachments\/[a-f0-9-]{36}\/content$/.test(route))return read;
    if(route==='/api/catalog-reactions')return read||['PUT','DELETE'].includes(verb);
    if(/^\/api\/catalog-reactions\/(mcp|plugin|skill|model|agent)\/[^/]+$/.test(route))return ['PUT','DELETE'].includes(verb);
    if(route==='/api/catalog-requests'){return ['GET','HEAD','POST'].includes(request.method.toUpperCase());}
    if(route==='/api/catalog-requests/targets'){return read;}
    if(/^\/api\/catalog-requests\/[a-f0-9-]{36}$/.test(route)){return read||request.method.toUpperCase()==='PATCH';}
    if(/^\/api\/catalog-requests\/[a-f0-9-]{36}\/actions$/.test(route)){return request.method.toUpperCase()==='POST';}
    if (/^\/api\/(devices|device-jobs|device-pairs)(\/|$)/.test(route)) { return true; }
    if(route==='/api/device-installations'){return read;}
    if (/^\/api\/device-install-plans(?:\/|$)/.test(route)) { return read || ['Разработчик','Админ проекта','Главный админ'].includes(activeRole); }
    const project = /^\/api\/projects\/([^/]+)(?:\/(.*))?$/.exec(route);
    if (project && project[1] !== 'import-local') {
        const level = projectLevel(claims,activeRole,project[1]);
        if (!level) { return false; }
        if(project[2]?.startsWith('team-chat'))return allowProjectChat(level,verb,project[2]);
        if(project[2]&&/^learning(?:[/%]|$)/.test(project[2]))return allowLearningRoute(level,request.method.toUpperCase(),project[2]);
        const trial = project[2] && allowAgentReadinessRoute(level, request.method.toUpperCase(), project[2]);
        if (typeof trial === 'boolean') return trial;
        if (project[2]?.startsWith('backups')) { return level >= 3; }
        if (read) { return true; }
        if (project[2]?.startsWith('members') && body.role === 'Админ проекта' && !main) { return false; }
        return level >= 3;
    }
    if (route === '/api/projects') { return read || main; }
    if (route === '/api/projects/import-local') { return main; }
    if (route.startsWith('/api/platform/users')) { return main; }
    if (route === '/api/feature-flags/evaluated') { return read; }
    if (route === '/api/feature-flags' || route.startsWith('/api/feature-flags/')) { return main; }
    if(route==='/api/bridge-source')return read||main&&request.method.toUpperCase()==='PUT';
    if(route==='/api/bridge-source/check')return request.method.toUpperCase()==='POST';
    if(route==='/api/bridge-source/import')return main&&request.method.toUpperCase()==='POST';
    if (/^\/api\/(asset-sources|asset-imports|asset-management)(?:\/|$)/.test(route)) { return main; }
    if (route === '/api/tool-builds' || route.startsWith('/api/tool-builds/')) { return main; }
    if (route.startsWith('/api/maintenance') || route === '/api/audit') { return main; }
    if (route === '/api/model-usage') return read && ['Главный админ', 'Админ проекта', 'Разработчик'].includes(activeRole);
    if(route==='/api/agents'){return read||main&&request.method.toUpperCase()==='POST';}
    if(/^\/api\/agents\/agent-[a-z0-9][a-z0-9-]{0,120}$/.test(route)){return read||main&&request.method.toUpperCase()==='PATCH';}
    if (route === '/api/model-chats' || route.startsWith('/api/model-chats/')) {
        if (!['Главный админ', 'Админ проекта', 'Разработчик'].includes(activeRole)) return false;
        const method = request.method.toUpperCase(), id = '[a-f0-9-]{36}', root = '/api/model-chats';
        // The executor additionally checks personal ownership and the current model/project assignment.
        if (route === root) return ['GET', 'HEAD', 'POST'].includes(method);
        if (route === root + '/agents' || route === root + '/research-tools') return ['GET', 'HEAD'].includes(method);
        if (new RegExp(`^${root}/${id}$`).test(route)) return ['GET', 'HEAD', 'PATCH', 'DELETE'].includes(method);
        if (new RegExp(`^${root}/${id}/(?:research-tools|research-steps/${id}|turns/${id}/research-steps)$`).test(route)) return ['GET', 'HEAD'].includes(method);
        if (new RegExp(`^${root}/${id}/history$`).test(route)) return ['GET', 'HEAD'].includes(method);
        if (new RegExp(`^${root}/${id}/agents$`).test(route)) return ['GET', 'HEAD'].includes(method);
        if (new RegExp(`^${root}/${id}/participants$`).test(route)) return method === 'PUT';
        if (new RegExp(`^${root}/${id}/attachments/${id}$`).test(route)) return ['GET', 'HEAD', 'DELETE'].includes(method);
        if (new RegExp(`^${root}/${id}/turns/${id}$`).test(route)) return method === 'DELETE';
        return method === 'POST' && new RegExp(`^${root}/${id}/(?:attachments|context-preview|turns(?:/${id}/(?:retry|cancel|complete))?)$`).test(route);
    }
    if (/^\/api\/models\/[^/]+\/rate-limit$/.test(route)) return read ? common : main && verb === 'PUT';
    if (route === '/api/models') { return read || main; }
    const model = /^\/api\/models\/[^/]+(?:\/(.*))?$/.exec(route);
    if (model) {
        if (model[1] === 'connection') { return main; }
        if (read) { return true; }
        if (['ollama/api/embed', 'ollama/api/chat', 'ollama/v1/embeddings', 'ollama/v1/chat/completions'].includes(model[1] ?? '')) {
            // Точная область назначения и роль в проекте повторно проверяются модельным контроллером.
            return ['Главный админ', 'Админ проекта', 'Разработчик'].includes(activeRole);
        }
        return main;
    }
    if (route === '/api/access/users') { return common; }
    if (route === '/api/me/decisions') { return read; }
    // The real executor rechecks ownership, current role, project scope and state under CAS.
    if (route.startsWith('/api/operations')) { return read || request.method.toUpperCase()==='POST'&&/^\/api\/operations\/[^/]+\/(retry|cancel)$/.test(route); }
    if (route === '/api/local-assets/scan') { return main; }
    if (route === '/api/local-assets/install') { return projectLevel(claims,activeRole,String(body.projectName ?? '')) >= 2; }
    if (route === '/api/ai-plugins') { return read || main; }
    const plugin = /^\/api\/ai-plugins\/([^/]+)/.exec(route);
    if (plugin) { return read ? common || claims.pluginIds.includes(plugin[1]) : main; }
    if (route === '/api/rag/projects') { return read; }
    if (route.startsWith('/api/rag/')) {
        if(route==='/api/rag/sync'&&!read){return projectLevel(claims,activeRole,String(body.projectKey??''))>=2;}
        return projectLevel(claims,activeRole,String(read ? request.query?.projectKey ?? '' : body.projectKey ?? '')) >= (read ? 1 : 3);
    }
    if (route.startsWith('/api/skills')) {
        if (route === '/api/skills/sync') { return projectLevel(claims,activeRole,String(body.projectKey ?? '')) >= 2; }
        // При редактировании и удалении сервис использует URL, поэтому тело не определяет область прав.
        const createsPath=request.method.toUpperCase()==='POST'&&['/api/skills','/api/skills/directory'].includes(route);
        let skillPath = String(createsPath ? body.path ?? '' : route.slice('/api/skills/'.length)).replace(/^\//,'');
        if (read && skillPath.startsWith('_package/')) { skillPath = skillPath.slice('_package/'.length); }
        if (read && (route === '/api/skills' || route === '/api/skills/tree')) { return true; }
        if (main) { return true; }
        const scope = /^project-([^/]+)(?:\/|$)/.exec(skillPath);
        if (scope) { return projectLevel(claims,activeRole,scope[1]) >= (read ? 1 : 2); }
        return read && (common || claims.skillPaths.includes(skillPath));
    }
    return false;
}


/** Route admission complements fresh executor membership and authorship checks. */
function allowProjectChat(level:number,verb:string,suffix:string):boolean {
    if(suffix==='team-chat/rooms')return ['GET','HEAD'].includes(verb)||verb==='POST'&&level>=2;
    const dialog=/^team-chat\/rooms\/[a-f0-9-]{36}(?:\/(.*))?$/.exec(suffix);
    if(dialog){
        if(!dialog[1])return ['GET','HEAD'].includes(verb)||verb==='PUT'&&level>=2;
        suffix='team-chat/'+dialog[1];
    }
    if(suffix==='team-chat/activity')return ['GET','HEAD','PUT'].includes(verb);
    if(suffix==='team-chat'||suffix==='team-chat/history')return ['GET','HEAD'].includes(verb);
    if(suffix==='team-chat/participants')return verb==='PUT'&&level>=(dialog?2:3);
    return verb==='POST'&&level>=2&&(suffix==='team-chat/messages'||/^team-chat\/messages\/[a-f0-9-]{36}\/(retry|cancel)$/.test(suffix));
}
