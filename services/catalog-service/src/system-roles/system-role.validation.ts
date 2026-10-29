import { BadRequestException, ConflictException } from '@nestjs/common';
import {normalizeTextContext} from '../../../shared/project-text-knowledge.cjs';
import {normalizeRoleMcpSelection} from '../../../shared/system-role-mcp.cjs';
import { validateModelId } from '../models/model-validation';
import { ROLE_BUDGET, ROLE_GUIDANCE_POLICY, SYSTEM_ROLE_DEFINITIONS, roleDefinitionPin, systemRole } from './system-role.definitions';
import type {RoleGuidanceEvidence} from './system-role.types';
import { legacyRoleDefinitionPin } from './system-role.legacy-contract';
import { previousRoleDefinitionPin } from './system-role.previous-contract';
import type { DiagnosticFact, RolePrepared, RoleResult, RoleSelection, RoleTargetSelection, StartRoleRun, SystemRoleId } from './system-role.types';

export const roleObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const fail = (): never => { throw new BadRequestException('Передайте ограниченный выбор системного агента и актуальные pins.'); };
const exact = (value: unknown, keys: string[]): Record<string, unknown> => {
    if (!roleObject(value) || Object.keys(value).some(key => !keys.includes(key))) return fail(); return value;
};
const text = (value: unknown, limit: number, empty = false): value is string => typeof value === 'string' && (empty || !!value.trim()) && Buffer.byteLength(value) <= limit && !value.includes('\0');
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const roleRequestId = (value: unknown): string => {
    if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)) return fail(); return value;
};
export function roleSelection(id: SystemRoleId, value: unknown, start = false): RoleSelection {
    const raw = exact(value, ['projectId', 'instruction', 'diagnostics', 'targets', 'mcp','textContext', ...(start ? ['requestId', 'modelId', 'expectedModelPin', 'expectedDefinitionPin', 'consentDigest', 'sourceFeature', 'source'] : [])]);
    const definition = systemRole(id);
    if (raw.projectId !== null && (!text(raw.projectId, 128) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(raw.projectId))
        || !text(raw.instruction, 2048) || !Array.isArray(raw.diagnostics) || raw.diagnostics.length > ROLE_BUDGET.diagnostics
        || new Set(raw.diagnostics).size !== raw.diagnostics.length || raw.diagnostics.some(kind => !definition.diagnostics.includes(kind as never))
        || !Array.isArray(raw.targets) || raw.targets.length > ROLE_BUDGET.targets) return fail();
    const targets: RoleTargetSelection[] = raw.targets.map(value => {
        const target = exact(value, ['kind', 'id', 'text']);
        if (!definition.targets.includes(target.kind as never) || !text(target.id, 200) || /[\r\n\\]/.test(target.id)
            || target.kind === 'prompt' && !text(target.text, 32768)
            || target.kind !== 'prompt' && target.text !== undefined) return fail();
        return target as unknown as RoleTargetSelection;
    });
    if (new Set(targets.map(item => JSON.stringify([item.kind, item.id]))).size !== targets.length) return fail();
    let mcp:RoleSelection['mcp'];try{mcp=normalizeRoleMcpSelection(raw.mcp);}catch{return fail();}
    if(mcp?.length&&!raw.projectId)return fail();
    let textContext:RoleSelection['textContext'];try{textContext=raw.textContext===undefined?undefined:normalizeTextContext(raw.textContext);}catch{return fail();}
    if(textContext&&!raw.projectId)return fail();
    return { projectId: raw.projectId as string | null, instruction: raw.instruction, diagnostics: raw.diagnostics as RoleSelection['diagnostics'], targets,...(mcp?.length?{mcp}:{}),...(textContext?{textContext}:{}) };
}
/** A start repeats the preview selection; the server re-reads versions before checking the consent digest. */
export function startRoleRun(id: SystemRoleId, value: unknown): StartRoleRun {
    const selection = roleSelection(id, value, true), raw = value as Record<string, unknown>;
    if (!sha(raw.expectedModelPin) || !sha(raw.expectedDefinitionPin) || !sha(raw.consentDigest) || raw.sourceFeature !== undefined && raw.sourceFeature !== 'system_role_chat') return fail();
    let source: StartRoleRun['source'];
    if (raw.source !== undefined) { const selected = exact(raw.source, ['kind', 'dialogId', 'turnId']);
        if (selected.kind !== 'system-role-chat' || raw.sourceFeature !== 'system_role_chat') return fail();
        source = {kind: 'system-role-chat', dialogId: roleRequestId(selected.dialogId), turnId: roleRequestId(selected.turnId)};
    }
    if (raw.sourceFeature && !source) return fail();
    return { ...selection, requestId: roleRequestId(raw.requestId), modelId: validateModelId(raw.modelId), expectedModelPin: raw.expectedModelPin,
        expectedDefinitionPin: raw.expectedDefinitionPin, consentDigest: raw.consentDigest, ...(raw.sourceFeature ? { sourceFeature: raw.sourceFeature, source } : {}) };
}
export function roleAction(value: unknown): { expectedRevision: number; requestId: string } {
    const raw = exact(value, ['expectedRevision', 'requestId']);
    if (!Number.isSafeInteger(raw.expectedRevision) || Number(raw.expectedRevision) < 0) return fail();
    return { expectedRevision: Number(raw.expectedRevision), requestId: roleRequestId(raw.requestId) };
}
/** Model output can reference only server-held evidence and explicitly selected target identities. */
export function roleResult(content: string, prepared: RolePrepared, facts: DiagnosticFact[], projectContext?: RoleResult['projectContext'], guidance?: RoleGuidanceEvidence): RoleResult {
    const invalid = (): never => { throw new ConflictException('Ответ системного агента не прошёл проверку JSON-контракта.'); };
    if (Buffer.byteLength(content) > ROLE_BUDGET.outputBytes) return invalid();
    let value: unknown; try { value = JSON.parse(content); } catch { return invalid(); }
    const fullAnswer = SYSTEM_ROLE_DEFINITIONS.some(role => prepared.definitionPin === roleDefinitionPin(role.id));
    if (!roleObject(value) || Object.keys(value).sort().join(',') !== (fullAnswer || roleObject(value) && 'answer' in value ? 'answer,changes,findings,kind,nextSteps,summary' : 'changes,findings,kind,nextSteps,summary')
        || (fullAnswer || 'answer' in value) && !text(value.answer, ROLE_GUIDANCE_POLICY.answerBytes)
        || !['diagnosis', 'proposal'].includes(String(value.kind)) || !text(value.summary, 2048)
        || !Array.isArray(value.findings) || value.findings.length > 20 || !Array.isArray(value.nextSteps) || value.nextSteps.length > 10
        || value.nextSteps.some(step => !text(step, 1024)) || !Array.isArray(value.changes) || value.changes.length > ROLE_BUDGET.targets) return invalid();
    const evidence = new Set([...facts.map(fact => fact.id), ...(projectContext?.sources.map(source => source.id) ?? []), ...(guidance?.sources.map(source => source.id) ?? [])]), targets = new Map(prepared.targets.map(target => [target.key, target]));
    for (const finding of value.findings) if (!roleObject(finding) || Object.keys(finding).sort().join(',') !== 'detail,evidenceId'
        || !text(finding.detail, 2048) || !evidence.has(String(finding.evidenceId))) return invalid();
    for (const change of value.changes) if (!roleObject(change) || Object.keys(change).sort().join(',') !== 'explanation,replacement,targetKey'
        || !targets.has(String(change.targetKey)) || ['public-chat','package-source','dialog-context'].includes(targets.get(String(change.targetKey))?.kind ?? '') || !text(change.replacement, 32768) || !text(change.explanation, 2048)) return invalid();
    if (new Set(value.changes.map(change => (change as { targetKey: string }).targetKey)).size !== value.changes.length
        || (value.kind === 'diagnosis' ? value.changes.length !== 0 : value.changes.length === 0)
        || ['agent-packager', 'agent-coordinator'].some(id => prepared.definitionPin === roleDefinitionPin(id as SystemRoleId)
            || prepared.definitionPin === legacyRoleDefinitionPin(id as SystemRoleId) || prepared.definitionPin === previousRoleDefinitionPin(id as SystemRoleId)) && value.kind !== 'diagnosis') return invalid();
    return { ...value, ...(projectContext ? { projectContext } : {}), ...(guidance ? {guidance} : {}) } as unknown as RoleResult;
}
