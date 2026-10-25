import { writeFile } from 'node:fs/promises';
import { modelFromRow } from '../../src/models/model-history';
import { projectEmbeddingPin } from '../../src/models/project-embedding.validation';
import { roleDefinitionPin, roleHash, SYSTEM_ROLE_DEFINITIONS } from '../../src/system-roles/system-role.definitions';
import { SystemRoleTargets } from '../../src/system-roles/system-role.targets';
import { startRoleRun } from '../../src/system-roles/system-role.validation';
import type { RoleRunRow, RoleSelection, SystemRoleId } from '../../src/system-roles/system-role.types';
import { LEGACY_BASE, LEGACY_IDS, LEGACY_TIME, legacyAuthorityPort, legacySelection } from './system-role-rag-legacy-port';

/** Run only in root's private exact-BASE source overlay; hashes come from that revision's actual owners. */
async function main() {
    if (process.env.ROLE_LEGACY_FIXTURE_BASE !== LEGACY_BASE || !process.argv[2]) throw Error('Exact BASE attestation and output path required.');
    const port = legacyAuthorityPort(), definition = SYSTEM_ROLE_DEFINITIONS.find(item => item.id === 'agent-autoconfigurator')!;
    if (definition.prompt.includes('разрешённые фрагменты базы знаний') || roleDefinitionPin(definition.id) !== roleHash(definition)) throw Error('Generator requires unmodified eacf600 definitions.');
    const owner = new SystemRoleTargets(port.policy, port.agents as never, {} as never, {} as never);
    const prepare = async (id: SystemRoleId, runId: string, requestId: string, selection: RoleSelection = legacySelection()) => {
        const snapshot = await owner.prepare(port.req, id, selection);
        if ('projectContext' in snapshot) throw Error('BASE fixture must be grantless.');
        const model = modelFromRow(port.modelRow), request = startRoleRun(id, { ...snapshot.selection, requestId,
            modelId: model.id, expectedModelPin: projectEmbeddingPin(model), expectedDefinitionPin: snapshot.definitionPin,
            consentDigest: snapshot.consentDigest, sourceFeature: 'system_role_chat', source: { kind: 'system-role-chat', dialogId: LEGACY_IDS.dialog, turnId: LEGACY_IDS.turn } });
        const row: RoleRunRow = { id: runId, agent_id: id, project_id: port.project.id, actor: port.actor.email, actor_role: port.actor.activeRole,
            request_id: request.requestId, request_hash: roleHash({ id, input: request }), request, snapshot, model,
            state: 'running', phase: 'collecting', revision: 1, lease_token: 'legacy-controlled-lease', lease_until: '2026-10-25T00:02:00.000Z',
            calls_started: 0, facts: [], result: null, applied: [], steps: [], message: 'Собираем выбранные диагностические сведения.',
            created_at: LEGACY_TIME, finished_at: null };
        const accepted = legacyAuthorityPort(row);
        await accepted.policy.current(accepted.req, row, accepted.db as never);
        return row;
    };
    const row = await prepare('agent-autoconfigurator', LEGACY_IDS.run, LEGACY_IDS.request);
    const coordinatorRow = await prepare('agent-coordinator', '62345678-1234-1234-1234-123456789abc', '52345678-1234-1234-1234-123456789abc');
    const packagerRow = await prepare('agent-packager', '72345678-1234-1234-1234-123456789abc', '82345678-1234-1234-1234-123456789abc',
        { ...legacySelection(), targets: [{ kind: 'prompt', id: 'legacy-packager-context', text: 'Явно выбранный вопрос упаковщику.' }] });
    const fixture = { kind: 'system-role-eacf600-accepted-grantless-v1', base: LEGACY_BASE, controlledTime: LEGACY_TIME,
        projectSearchAtAdmission: false, recipe: 'Exact BASE SystemRoleTargets.prepare -> startRoleRun -> roleHash -> real SystemRolePolicy.current; no copied hash implementation.',
        definitions: SYSTEM_ROLE_DEFINITIONS.map(item => ({ definition: item, pin: roleDefinitionPin(item.id) })), row, coordinatorRow, packagerRow };
    await writeFile(process.argv[2], JSON.stringify(fixture, null, 2) + '\n', { flag: 'wx' });
}
void main().catch(error => { process.stderr.write(String(error) + '\n'); process.exitCode = 1; });
