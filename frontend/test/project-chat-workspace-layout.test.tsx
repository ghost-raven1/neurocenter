// @vitest-environment jsdom
import './feature-flags-enabled';
import {act, createElement, StrictMode, useState} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {Modal} from 'antd';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {ProjectChatWorkspace} from '../src/features/ProjectChat/ProjectChatWorkspace';
import {projectMessage, projectRoom} from './project-chat-fixtures';
import {model} from './model-chat-fixtures';
import {DEFAULT_PROJECT_CHAT_ROOM, type ProjectChatDetail, type ProjectChatRoomSummary} from '../src/features/ProjectChat/types';
import {modelChatApi} from '../src/features/ModelChat/api';

type Chat = ReturnType<typeof import('../src/features/ProjectChat/useProjectChat').useProjectChat>;
const h = vi.hoisted(() => ({
    owner: 'layout-viewer', rooms: [] as ProjectChatRoomSummary[], details: {} as Record<string, ProjectChatDetail>, canCreate: true,
    chatError: '', roomsError: '', selected: vi.fn(), create: vi.fn(), refresh: vi.fn(), visible: vi.fn(), typing: vi.fn(),
    send: vi.fn(), cancel: vi.fn(), configure: vi.fn(), close: vi.fn(), capture: () => () => true,
}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({useAuthRequestOwner: () => ({scope: h.owner, captureOwner: h.capture})}));
vi.mock('../src/features/ProjectChat/useProjectChatRooms', () => ({useProjectChatRooms: () => {
    const [roomId, setRoomId] = useState(DEFAULT_PROJECT_CHAT_ROOM);
    return {roomId, data: {rooms: h.rooms, members: projectRoom().members, canCreate: h.canCreate}, loading: false, error: h.roomsError,
        select: (id: string) => {h.selected(id); setRoomId(id);}, refresh: h.refresh, create: h.create, update: vi.fn(), compare: vi.fn(), forget: vi.fn()};
}}));
vi.mock('../src/features/ProjectChat/useProjectChat', () => ({useProjectChat: (_projectId: string, roomId: string): Chat => ({detail: h.details[roomId], loading: false, error: h.chatError,
    action: '', retryPending: [], historyLoading: false, historyError: '', accessDenied: false, refresh: h.refresh, clearAccess: vi.fn(), loadEarlier: vi.fn(),
    retry: vi.fn(), cancel: h.cancel, send: h.send, configure: h.configure})}));
vi.mock('../src/features/ProjectChat/useProjectChatActivity', () => ({useProjectChatActivity: () => ({snapshot: undefined, enabled: false, connected: false, onVisible: h.visible, onTyping: h.typing})}));
vi.mock('../src/features/ModelChat/api', () => ({modelChatApi: {agents: vi.fn()}}));
vi.mock('../src/features/ModelCatalog/useModelCatalog', () => ({useModelCatalog: () => ({catalog: {items: [{...model, id: 'model-chat', modelPin: 'a'.repeat(64)}], assignedModelIds: ['model-chat']}, loading: false, error: '', refresh: vi.fn()})}));
vi.mock('../src/features/ProjectChat/ProjectChatDialogForm', () => ({ProjectChatDialogForm: () => createElement('div', {role: 'dialog', 'aria-label': 'Новый диалог'}, 'Настройка нового диалога')}));

let container: HTMLDivElement, root: Root, sequence = 0;
const privateId = '115af965-9952-402f-8811-20ae55f47991';
const settle = async () => {await act(async () => {await new Promise(done => setTimeout(done, 60));});};
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === label || node.getAttribute('aria-label') === label)!;
const panel = (label: string) => document.querySelector<HTMLElement>(`.project-chat-panel__panel[aria-label="${label}"]`)!;
async function click(element: HTMLElement) {expect(element).toBeTruthy(); await act(async () => {element.dispatchEvent(new MouseEvent('click', {bubbles: true}));}); await settle();}
async function escape(element: HTMLElement) {await act(async () => {element.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', keyCode: 27, which: 27, bubbles: true}));}); await settle();}
async function type(body: string) {
    const input = document.querySelector<HTMLTextAreaElement>('#project-chat-message')!;
    await act(async () => {Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, body); input.dispatchEvent(new Event('input', {bubbles: true}));});
    await settle();
}
const render = async () => {await act(async () => {root.render(createElement(StrictMode, null, createElement(Modal, {open: true, footer: null, title: 'Проект', onCancel: h.close, getContainer: false}, createElement(ProjectChatWorkspace, {projectId: 'prj-one', projectName: 'Проект'}))));}); await settle();};
beforeEach(() => {
    vi.clearAllMocks(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); h.owner = `layout-viewer-${++sequence}`;
    h.canCreate = true; h.chatError = ''; h.roomsError = '';
    h.rooms = [{id: DEFAULT_PROJECT_CHAT_ROOM, title: 'Общий чат', visibility: 'PUBLIC', revision: 1, updatedAt: '', canManage: false, memberEmails: []},
        {id: privateId, title: 'Закрытое ревью', visibility: 'PRIVATE', revision: 2, updatedAt: '', canManage: true, memberEmails: ['alice@example.test']}];
    h.details = {[DEFAULT_PROJECT_CHAT_ROOM]: projectRoom({room: {...projectRoom().room, id: DEFAULT_PROJECT_CHAT_ROOM, title: 'Общий чат', visibility: 'PUBLIC'}, messages: [projectMessage()]}),
        [privateId]: projectRoom({room: {...projectRoom().room, id: privateId, title: 'Закрытое ревью', visibility: 'PRIVATE'}, messages: []})};
    h.send.mockResolvedValue({message: projectMessage(), roomRevision: 2}); h.configure.mockResolvedValue(false);
    vi.mocked(modelChatApi.agents).mockResolvedValue(projectRoom().agents);
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => {await act(async () => {root.unmount();}); container.remove(); vi.unstubAllGlobals();});

describe('Project workspace navigation and real AntD panels', () => {
    it('opens and returns from the room list without remounting the history, losing a draft or sending read receipts', async () => {
        await render(); await type('Неотправленный вопрос'); const log = document.querySelector('[role="log"]');
        await click(button('Диалоги')); expect(button('Диалоги').getAttribute('aria-expanded')).toBe('true');
        expect(document.activeElement?.getAttribute('aria-current')).toBe('page');
        await escape(document.activeElement as HTMLElement); expect(button('Диалоги').getAttribute('aria-expanded')).toBe('false'); expect(document.activeElement).toBe(button('Диалоги'));
        expect(document.querySelector('[role="log"]')).toBe(log); expect(document.querySelector<HTMLTextAreaElement>('#project-chat-message')!.value).toBe('Неотправленный вопрос');
        await click(button('Диалоги')); await click(button('Вернуться к чату')); expect(document.activeElement).toBe(button('Диалоги'));
        expect(h.selected).not.toHaveBeenCalled(); expect(h.send).not.toHaveBeenCalled(); expect(h.cancel).not.toHaveBeenCalled(); expect(h.visible).not.toHaveBeenCalled(); expect(h.close).not.toHaveBeenCalled();
    });
    it('shows only supplied authorized rooms and keeps a separate draft when explicitly changing room', async () => {
        await render(); await type('Черновик общего чата'); await click(button('Диалоги'));
        const rooms = document.querySelectorAll('.project-chat__room'); expect(rooms).toHaveLength(2); expect(rooms[1].textContent).toContain('Только участники диалога');
        await click(rooms[1] as HTMLElement); expect(h.selected).toHaveBeenCalledExactlyOnceWith(privateId); expect(button('Диалоги').getAttribute('aria-expanded')).toBe('false');
        expect(document.querySelector('.project-chat__room-title')!.textContent).toContain('Закрытый · только участники диалога'); expect(document.querySelector<HTMLTextAreaElement>('#project-chat-message')!.value).toBe('');
        await type('Приватный черновик'); await click(button('Диалоги')); await click(document.querySelectorAll<HTMLElement>('.project-chat__room')[0]);
        expect(document.querySelector<HTMLTextAreaElement>('#project-chat-message')!.value).toBe('Черновик общего чата'); expect(h.send).not.toHaveBeenCalled(); expect(h.cancel).not.toHaveBeenCalled();
    });
    it('folds agent configuration without discarding its edited roster or silently adopting a server revision', async () => {
        await render(); expect(document.querySelector('[aria-label="Настройка агентов команды"]')).toBeNull(); expect(modelChatApi.agents).not.toHaveBeenCalled();
        await click(button('Настроить агентов')); const settings = panel('Настроить агентов'); expect(document.activeElement).toBe(settings);
        const reviewer = [...settings.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(input => input.closest('label')!.textContent!.includes('Ревьюер'))!;
        await click(reviewer); expect(reviewer.checked).toBe(false); await click(button('Закрыть: Настроить агентов')); expect(document.activeElement).toBe(button('Настроить агентов'));
        h.details[DEFAULT_PROJECT_CHAT_ROOM] = {...h.details[DEFAULT_PROJECT_CHAT_ROOM], room: {...h.details[DEFAULT_PROJECT_CHAT_ROOM].room, revision: 6, agentIds: ['reviewer']}}; await render();
        await click(button('Настроить агентов')); const reopened = panel('Настроить агентов'); expect(reopened.textContent).toContain('Другой администратор изменил состав');
        expect(reopened.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[0].checked).toBe(true); expect(reopened.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1].checked).toBe(false);
        expect(button('Сохранить агентов').disabled).toBe(true); expect(h.configure).not.toHaveBeenCalled(); expect(h.send).not.toHaveBeenCalled();
    });
    it('reopens its own successfully saved roster without a false conflict and saves the next edit with the new revision', async () => {
        await render(); await click(button('Настроить агентов'));
        const reviewer = [...panel('Настроить агентов').querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(input => input.closest('label')!.textContent!.includes('Ревьюер'))!;
        await click(reviewer);
        h.configure.mockImplementationOnce(async () => {
            h.details[DEFAULT_PROJECT_CHAT_ROOM] = {...h.details[DEFAULT_PROJECT_CHAT_ROOM], room: {...h.details[DEFAULT_PROJECT_CHAT_ROOM].room, revision: 3, agentIds: ['developer']}};
            return true;
        });
        await click(button('Сохранить агентов')); expect(h.configure).toHaveBeenCalledExactlyOnceWith(['developer'], 'model-chat', 'a'.repeat(64), 1);
        expect(button('Настроить агентов').getAttribute('aria-expanded')).toBe('false');
        await click(button('Настроить агентов')); const reopened = panel('Настроить агентов');
        expect(reopened.textContent).not.toContain('Другой администратор изменил состав');
        const agents = reopened.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'); expect(agents[0].checked).toBe(true); expect(agents[1].checked).toBe(false);
        await click(agents[0]); expect(button('Сохранить агентов').disabled).toBe(false);
        h.configure.mockImplementationOnce(async () => {
            h.details[DEFAULT_PROJECT_CHAT_ROOM] = {...h.details[DEFAULT_PROJECT_CHAT_ROOM], room: {...h.details[DEFAULT_PROJECT_CHAT_ROOM].room, revision: 4, agentIds: [], modelId: null, modelPin: null}};
            return true;
        });
        await click(button('Сохранить агентов')); expect(h.configure).toHaveBeenNthCalledWith(2, [], undefined, undefined, 3);
        expect(button('Настроить агентов').getAttribute('aria-expanded')).toBe('false'); expect(h.send).not.toHaveBeenCalled();
    });
    it('recipient details preserve the draft; Escape closes Select first and then returns focus without closing chat', async () => {
        await render(); await type('Вопрос коллегам'); const trigger = button('Кому отправить сообщение'); await click(trigger);
        const recipients = panel('Кому отправить сообщение'); expect(document.activeElement).toBe(recipients); expect(recipients.closest('[aria-modal="true"]')).toBeTruthy();
        const selector = recipients.querySelector<HTMLElement>('.ant-select-selector')!;
        await act(async () => {selector.dispatchEvent(new MouseEvent('mousedown', {bubbles: true}));}); await settle();
        const input = recipients.querySelector<HTMLInputElement>('[role="combobox"]')!; expect(input.getAttribute('aria-expanded')).toBe('true');
        await escape(input); expect(input.getAttribute('aria-expanded')).toBe('false'); expect(trigger.getAttribute('aria-expanded')).toBe('true');
        await escape(input); expect(trigger.getAttribute('aria-expanded')).toBe('false'); expect(document.activeElement).toBe(trigger); expect(h.close).not.toHaveBeenCalled();
        expect(document.querySelector<HTMLTextAreaElement>('#project-chat-message')!.value).toBe('Вопрос коллегам');
        expect(document.querySelector('#project-chat-recipients')!.textContent).toContain('Запрос к моделям не выполняется');
        await click(button('Отправить')); expect(h.send).toHaveBeenCalledWith(expect.objectContaining({prompt: 'Вопрос коллегам', targetAgentIds: []}));
    });
    it('shows one recovery notice only after a lost ACK and keeps retry separate from long feedback without changing the intent', async () => {
        let rejectSend!: (cause: unknown) => void;
        h.send.mockReturnValueOnce(new Promise((_resolve, reject) => {rejectSend = reject;}));
        await render(); await type('Сохранить вопрос для проверки'); await click(button('Отправить'));
        const composer = document.querySelector('.project-chat__composer')!;
        expect(composer.querySelectorAll('[role="alert"]')).toHaveLength(0); expect(composer.textContent).not.toContain('Подтверждение отправки не получено');
        expect(document.querySelector<HTMLTextAreaElement>('#project-chat-message')!.disabled).toBe(true);
        const sent = h.send.mock.calls[0][0], cause = 'Связь прервана, подтверждение отсутствует. '.repeat(16);
        await act(async () => {rejectSend(new Error(cause));}); await settle();
        const notices = composer.querySelectorAll('[role="alert"]'); expect(notices).toHaveLength(1); expect(notices[0].textContent).toContain(cause);
        const feedback = composer.querySelector<HTMLElement>('[role="region"][aria-label="Состояние отправки"]')!;
        expect(feedback.contains(notices[0])).toBe(true); expect(feedback.tabIndex).toBe(0); expect(feedback.contains(button('Проверить отправку'))).toBe(false);
        expect(button('Проверить отправку').disabled).toBe(false); await click(button('Проверить отправку'));
        expect(h.send.mock.calls[1][0]).toEqual(sent); expect(document.querySelector<HTMLTextAreaElement>('#project-chat-message')!.value).toBe('');
        expect(composer.querySelectorAll('[role="alert"]')).toHaveLength(0);
        h.send.mockRejectedValueOnce({isAxiosError: true, response: {status: 400, data: {message: 'Определённый отказ: исправьте запрос.'}}});
        await type('Редактируемый после отказа вопрос'); await click(button('Отправить'));
        expect(composer.querySelectorAll('[role="alert"]')).toHaveLength(1); expect(composer.querySelector('.ant-alert-error')!.textContent).toContain('Определённый отказ');
        expect(document.querySelector<HTMLTextAreaElement>('#project-chat-message')!.disabled).toBe(false); expect(document.querySelector<HTMLTextAreaElement>('#project-chat-message')!.value).toBe('Редактируемый после отказа вопрос');
        expect(button('Отправить').disabled).toBe(false); expect(composer.textContent).not.toContain('Проверить отправку');
    });
    it('opening a new form does not select a room or create a message, and read-only actions explain their state', async () => {
        await render(); await click(button('Новый диалог')); expect(document.querySelector('[aria-label="Новый диалог"]')).toBeTruthy();
        expect(h.create).not.toHaveBeenCalled(); expect(h.selected).not.toHaveBeenCalled(); expect(h.send).not.toHaveBeenCalled();
        h.canCreate = false; h.details[DEFAULT_PROJECT_CHAT_ROOM] = {...h.details[DEFAULT_PROJECT_CHAT_ROOM], canPost: false, canConfigure: false}; await render();
        expect(button('Новый диалог').disabled).toBe(true); expect(button('Новый диалог').title).toContain('нужна роль разработчика');
        expect(document.querySelector<HTMLTextAreaElement>('#project-chat-message')!.disabled).toBe(true); expect(document.querySelector<HTMLTextAreaElement>('#project-chat-message')!.placeholder).toContain('нужна роль разработчика');
        expect(button('Отправить').disabled).toBe(true); expect(document.querySelector('button[aria-label="Настроить агентов"]')).toBeNull();
    });
});
