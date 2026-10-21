import { canReadCommon, IAccessClaims, projectLevel } from './access.model';
import { canonicalAccessRoute } from '../../../shared/access-route.cjs';
import {allowLearningRoute} from './learning-access-policy';

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
    if (/^\/api\/(devices|device-jobs|device-pairs)(\/|$)/.test(route)) { return true; }
    if(route==='/api/device-installations'){return read;}
    if (/^\/api\/device-install-plans(?:\/|$)/.test(route)) { return read || ['Разработчик','Админ проекта','Главный админ'].includes(activeRole); }
    const project = /^\/api\/projects\/([^/]+)(?:\/(.*))?$/.exec(route);
    if (project && project[1] !== 'import-local') {
        const level = projectLevel(claims,activeRole,project[1]);
        if (!level) { return false; }
        if(project[2]&&/^learning(?:[/%]|$)/.test(project[2]))return allowLearningRoute(level,request.method.toUpperCase(),project[2]);
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
    if (/^\/api\/(asset-sources|asset-imports|asset-management)(?:\/|$)/.test(route)) { return main; }
    if (route === '/api/tool-builds' || route.startsWith('/api/tool-builds/')) { return main; }
    if (route.startsWith('/api/maintenance') || route === '/api/audit') { return main; }
    if(route==='/api/agents'){return read||main&&request.method.toUpperCase()==='POST';}
    if(/^\/api\/agents\/agent-[a-z0-9][a-z0-9-]{0,120}$/.test(route)){return read||main&&request.method.toUpperCase()==='PATCH';}
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

