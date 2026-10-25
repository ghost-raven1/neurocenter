import {describe, expect, it, vi} from 'vitest';
import {SystemRoleGuidance, roleHelpPage} from '../src/system-roles/system-role.guidance';
import {roleDefinitionPin, roleHash} from '../src/system-roles/system-role.definitions';
import {acceptedPreviousDefinition, previousRoleDefinitionPin, previousSystemRole} from '../src/system-roles/system-role.previous-contract';
import {roleResult} from '../src/system-roles/system-role.validation';
import type {RolePrepared, RoleRunRow} from '../src/system-roles/system-role.types';

function fixture() {
    const allowed = {value: true}, controller = new AbortController(), checked = vi.fn(async () => {if (!allowed.value) throw Error('revoked');});
    const actor = {email: 'member@example.test', activeRole: 'Разработчик'}, query = vi.fn(async () => ({rows: [{experiences: 0, hypotheses: 0}]}));
    const models = {pool: {query}, ready: async () => true, actor: vi.fn(async () => actor), resolveProject: vi.fn(async () => ({id: 'project-one'}))};
    const help = {list: vi.fn(async () => ({items: [{slug: 'getting-started', title: 'Подготовить проект', summary: 'Индекс и модели'}]})),
        read: vi.fn(async () => ({slug: 'getting-started', title: 'Подготовить проект', revision: 'revision-one', content: 'Проверьте модель и мост.\nAPI_KEY=do-not-send'}))};
    const diagnostic = vi.fn(async kind => ({kind, id: 'original-fact', status: 'measured', data: {available: true, mutationPerformed: false}}));
    const features = vi.fn(async () => undefined), broker = new SystemRoleGuidance(models as never,help as never,diagnostic as never,features);
    const collect = () => broker.collect({headers: {}} as never,'project-one','Почему не работает RAG?',controller.signal,checked);
    return {broker,collect,allowed,controller,checked,models,help,diagnostic,features,query};
}
describe('Measured role guidance and detailed answers', () => {
    it('calls real read owners under the caller scope and returns sources/actions rather than claiming a mutation', async () => {
        const f = fixture(), result = await f.collect(), payload = JSON.parse(result.content);
        expect(f.models.resolveProject).toHaveBeenCalledWith(expect.anything(),'project-one',1,expect.objectContaining({email: 'member@example.test'}));
        expect(f.diagnostic.mock.calls.map(([kind]) => kind)).toEqual(['health','project','index','bridge']);
        expect(f.help.read).toHaveBeenCalledWith(expect.anything(),'getting-started');
        expect(result.evidence.sources).toContainEqual({id: 'help:getting-started:revision-one', kind: 'help', title: 'Подготовить проект', slug: 'getting-started', revision: 'revision-one'});
        expect(payload).toMatchObject({mutationPerformed: false,scope: 'current-project-and-initiator-devices'});
        expect(result.content).not.toContain('do-not-send');
        expect(f.query.mock.calls[0]).toEqual([expect.stringContaining('email=$2'),['project-one','member@example.test']]);
        expect(f.query.mock.calls.every(([sql]) => !/INSERT|UPDATE|DELETE/.test(sql))).toBe(true);
        expect(result.actions.map(action => action.path)).toContain('/projects/project-one?tab=rag');
    });
    it('does not turn inaccessible help into invented evidence and still retains measured project checks', async () => {
        const f = fixture(); f.help.read.mockRejectedValue(Error('private raw error'));
        const result = await f.collect(); expect(result.evidence.status).toBe('ready'); expect(result.evidence.message).toContain('Справка недоступна');
        expect(result.evidence.sources.some(source => source.kind === 'help')).toBe(false); expect(result.content).not.toContain('private raw error');
    });
    it('does not read initiator-owned devices or queue when a regular agent answers a shared project room',async()=>{
        const f=fixture(),sentinel='private-device-sentinel';f.diagnostic.mockImplementation(async kind=>({kind,id:'fact',status:'measured',data:{available:true,...(kind==='bridge'?{deviceId:sentinel}:{})}}));
        const result=await f.broker.collect({headers:{}} as never,'project-one','Какой контекст доступен?',f.controller.signal,f.checked,'project-shared'),payload=JSON.parse(result.content);
        expect(f.diagnostic.mock.calls.map(([kind])=>kind)).toEqual(['health','project','index']);expect(f.query.mock.calls.some(([sql])=>sql.includes('bridge_jobs'))).toBe(false);
        expect(result.content).not.toContain(sentinel);expect(payload.scope).toBe('project-shared');expect(payload.checks.find(check=>check.name==='project-learning')?.data).not.toHaveProperty('queue');
    });
    it('stops after permission revocation or cancellation while a help read is in flight', async () => {
        const f = fixture(); f.help.read.mockImplementation(async () => {f.allowed.value = false; return {slug: 'getting-started',title: 'Guide',revision: 'one',content: 'text'};});
        await expect(f.collect()).rejects.toThrow('revoked');
        const cancelled = fixture(); cancelled.help.read.mockImplementation(async () => {cancelled.controller.abort(Error('cancelled')); throw Error('late');});
        await expect(cancelled.collect()).rejects.toThrow('cancelled');
    });
    it('closes optional new reads when OFF, preserving an honest unavailable answer context', async () => {
        const f = fixture(); f.features.mockRejectedValue(Error('off')); const result = await f.collect();
        expect(result.evidence).toMatchObject({status: 'unavailable',sources: []}); expect(f.help.list).not.toHaveBeenCalled(); expect(f.diagnostic).not.toHaveBeenCalled();
    });
    it('pages Unicode help with explicit omissions and no broken code point', () => {
        expect(roleHelpPage('а🌸б',6)).toEqual({content: 'а🌸',complete: false,nextOffset: 3});
        expect(roleHelpPage('а🌸б',8)).toEqual({content: 'а🌸б',complete: true});
    });
    it('requires a full answer for new definitions and accepts only delivered evidence IDs', () => {
        const prepared = {definitionPin: roleDefinitionPin('agent-ai-admin'),targets: []} as unknown as RolePrepared;
        const value = {kind: 'diagnosis',summary: 'Причина найдена',findings: [{evidenceId: 'help:guide:one',detail: 'Проверьте подключение.'}],nextSteps: [],changes: []};
        const guidance = {status: 'ready' as const,checkedAt: new Date().toISOString(),sources: [{id: 'help:guide:one',kind: 'help' as const,title: 'Guide'}]};
        expect(() => roleResult(JSON.stringify(value),prepared,[],undefined,guidance)).toThrow('JSON-контракта');
        const full = {...value,answer: 'Проверен индекс. Модель не подключена. Откройте каталог, назначьте модель проекту и повторите проверку. Изменения не применялись. Основание: help:guide:one.'};
        expect(roleResult(JSON.stringify(full),prepared,[],undefined,guidance)).toMatchObject({...full,guidance});
        expect(() => roleResult(JSON.stringify(full),prepared,[])).toThrow('JSON-контракта');
        expect(() => roleResult(JSON.stringify({...full,answer: 'я'.repeat(7000)}),prepared,[],undefined,guidance)).toThrow('JSON-контракта');
    });
    it('recognizes exact accepted pre-guidance pins without upgrading context or rewriting stored receipts', () => {
        const definitionPin = previousRoleDefinitionPin('agent-ai-admin'), selection = {projectId: 'project-one',instruction: 'Check',diagnostics: [],targets: []};
        const consentDigest = roleHash({definitionPin,selection,targets: []}), request = {...selection,requestId: 'request-one',modelId: 'model-one',expectedDefinitionPin: definitionPin,consentDigest};
        const row = {agent_id: 'agent-ai-admin',project_id: selection.projectId,request,snapshot: {definitionPin,selection,targets: [],consentDigest},request_hash: roleHash({id: 'agent-ai-admin',input: request})} as unknown as RoleRunRow;
        const before = structuredClone(row); expect(acceptedPreviousDefinition(row)).toEqual(previousSystemRole('agent-ai-admin')); expect(row).toEqual(before);
        expect(definitionPin).not.toBe(roleDefinitionPin('agent-ai-admin'));
        expect(acceptedPreviousDefinition({...row,snapshot: {...row.snapshot,guidance: {version: 1,projectId: selection.projectId}}})).toBeUndefined();
        const old = {kind: 'diagnosis',summary: 'Старый сохранённый ответ',findings: [],nextSteps: [],changes: []};
        expect(roleResult(JSON.stringify(old),row.snapshot,[])).toEqual(old);
    });
});
