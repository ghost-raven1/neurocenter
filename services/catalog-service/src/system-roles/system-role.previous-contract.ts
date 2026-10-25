import {previousRoleContract as previous} from './system-role.previous-data';
import {roleHash} from './system-role.definitions';
import type {RoleDefinition, RoleRunRow, SystemRoleId} from './system-role.types';

/** Exact accepted pre-guidance contracts stay readable and executable without gaining a new grant. */
export const PREVIOUS_ROLE_DEFINITIONS = previous.definitions as unknown as readonly RoleDefinition[];
export const previousSystemRole = (id: SystemRoleId): RoleDefinition => PREVIOUS_ROLE_DEFINITIONS.find(item => item.id === id)!;
export const previousRoleDefinitionPin = (id: SystemRoleId): string => previous.pins[id];
export function acceptedPreviousDefinition(row: RoleRunRow): RoleDefinition | undefined {
    const {request, snapshot} = row, definitionPin = previousRoleDefinitionPin(row.agent_id);
    if (snapshot.guidance !== undefined || request.expectedDefinitionPin !== definitionPin || snapshot.definitionPin !== definitionPin
        || request.consentDigest !== snapshot.consentDigest || roleHash({id: row.agent_id, input: request}) !== row.request_hash) return;
    const selection = {projectId: request.projectId, instruction: request.instruction, diagnostics: request.diagnostics, targets: request.targets,
        ...(request.mcp?.length ? {mcp: request.mcp} : {})};
    if (row.project_id !== selection.projectId || roleHash(selection) !== roleHash(snapshot.selection)) return;
    const digest = roleHash({definitionPin, selection: snapshot.selection, targets: snapshot.targets.map(({key, pin, modelContent}) => ({key, pin, modelContent})),
        ...(snapshot.mcp ? {mcp: snapshot.mcp} : {}), ...(snapshot.projectContext ? {projectContext: snapshot.projectContext, projectKnowledge: previous.projectKnowledge} : {})});
    return digest === snapshot.consentDigest ? previousSystemRole(row.agent_id) : undefined;
}
