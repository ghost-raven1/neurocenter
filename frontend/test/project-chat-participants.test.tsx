import {harness, renderProjectUi, settleProjectUi, ui} from './project-chat-ui-fixture';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {ProjectChatParticipants} from '../src/features/ProjectChat/ProjectChatParticipants';
import {modelChatApi} from '../src/features/ModelChat/api';
import {projectRoom} from './project-chat-fixtures';
import {model} from './model-chat-fixtures';

vi.mock('../src/features/ModelChat/api', () => ({modelChatApi: {agents: vi.fn()}}));
vi.mock('../src/features/ModelCatalog/useModelCatalog', () => ({useModelCatalog: () => ({catalog: {items: [{...model, id: 'model-chat', modelPin: 'b'.repeat(64)}], assignedModelIds: ['model-chat']}, loading: false, error: '', refresh: vi.fn()})}));
let props: Parameters<typeof ProjectChatParticipants>[0];
const onSave = vi.fn(), onClose = vi.fn();
const element = () => ProjectChatParticipants(props);
beforeEach(() => {vi.clearAllMocks(); ui.flags.clear(); props = {projectId: 'prj-one', detail: projectRoom(), saving: false, error: '', onClose, onSave}; vi.mocked(modelChatApi.agents).mockResolvedValue(projectRoom().agents); onSave.mockResolvedValue(true);});
afterEach(() => harness.dispose());
describe('Настройка общей команды: восстановление и CAS', () => {
    it('Позволяет убрать агентов при флагах OFF, не подменяя сохранённый pin новой версией каталога', async () => {
        ui.flags.set('project_chat', false); ui.flags.set('group_chat', false); renderProjectUi(element); await settleProjectUi(element);
        const checkbox = ui.checks.get('Ревьюер · @reviewer')!; expect(checkbox.disabled).toBe(false); checkbox.onChange({target: {checked: false}}); renderProjectUi(element); ui.buttons.get('Сохранить агентов')!(); await settleProjectUi(element);
        expect(onSave).toHaveBeenCalledWith(['developer'], 'model-chat', 'a'.repeat(64), 1); expect(onClose).toHaveBeenCalledOnce();
    });
    it('Чужая смена состава не перебазирует локальный выбор молча', async () => {
        renderProjectUi(element); await settleProjectUi(element); ui.checks.get('Ревьюер · @reviewer')!.onChange({target: {checked: false}}); renderProjectUi(element);
        props.detail = {...props.detail, room: {...props.detail.room, revision: 5, agentIds: ['reviewer']}}; let view = renderProjectUi(element);
        expect(view.html).toContain('Другой администратор изменил состав'); expect(ui.buttons.has('Сохранить агентов')).toBe(false); expect(ui.checks.get('Разработчик · @developer')!.checked).toBe(true);
        ui.buttons.get('Оставить мой выбор')!(); renderProjectUi(element); ui.buttons.get('Сохранить агентов')!(); await settleProjectUi(element);
        expect(onSave).toHaveBeenCalledWith(['developer'], 'model-chat', 'b'.repeat(64), 5);
    });
    it('Новые сообщения меняют revision, сохраняя тот же состав; отправляет свежий CAS', async () => {
        renderProjectUi(element); await settleProjectUi(element); props.detail = {...props.detail, room: {...props.detail.room, revision: 12}}; renderProjectUi(element);
        ui.buttons.get('Сохранить агентов')!(); await settleProjectUi(element); expect(onSave).toHaveBeenCalledWith(['developer', 'reviewer'], 'model-chat', 'a'.repeat(64), 12);
    });
    it('Модельный pin обновляется только после явного действия администратора', async () => {
        renderProjectUi(element); await settleProjectUi(element); ui.buttons.get('Принять новую версию')!(); renderProjectUi(element); ui.buttons.get('Сохранить агентов')!(); await settleProjectUi(element);
        expect(onSave).toHaveBeenCalledWith(['developer', 'reviewer'], 'model-chat', 'b'.repeat(64), 1);
    });
});
