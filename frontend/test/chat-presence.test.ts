import {harness, ui} from './project-chat-ui-fixture';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import api from '../src/core/api/base';
import {useChatPresence} from '../src/features/ChatActivity/useChatPresence';

vi.mock('../src/core/api/base', () => ({default: {put: vi.fn()}}));
let focused: boolean, visibility: string;
const render = (authenticated = true) => {harness.begin(); useChatPresence(authenticated); harness.commit();};
beforeEach(() => {
    vi.useFakeTimers(); vi.clearAllMocks(); ui.flags.clear(); ui.owner = 'alice'; ui.scope = 'alice'; focused = true; visibility = 'visible';
    vi.mocked(api.put).mockResolvedValue({data: {}}); vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('document', Object.defineProperty(Object.assign(new EventTarget(), {hasFocus: () => focused}), 'visibilityState', {get: () => visibility}));
});
afterEach(() => {harness.dispose(); vi.useRealTimers(); vi.unstubAllGlobals();});
describe('Присутствие живёт в приложении независимо от комнаты', () => {
    it('Обновляет только собственный сеанс каждые10 секунд, blur очищает его с большей sequence', async () => {
        render(); expect(api.put).toHaveBeenCalledOnce(); await vi.advanceTimersByTimeAsync(10000); expect(api.put).toHaveBeenCalledTimes(2);
        const first = vi.mocked(api.put).mock.calls[0][1]; focused = false; window.dispatchEvent(new Event('blur'));
        const last = vi.mocked(api.put).mock.calls.at(-1)![1]; expect(last).toMatchObject({sessionId: first.sessionId, online: false}); expect(last.sequence).toBeGreaterThan(first.sequence);
        await vi.advanceTimersByTimeAsync(20000); expect(api.put).toHaveBeenCalledTimes(3);
    });
    it('OFF и выход завершают собственный сеанс, чужие вкладки не затрагивают', () => {
        render(); const id = vi.mocked(api.put).mock.calls[0][1].sessionId; ui.flags.set('chat_activity', false); render();
        expect(vi.mocked(api.put).mock.calls.at(-1)![1]).toMatchObject({sessionId: id, online: false}); const count = vi.mocked(api.put).mock.calls.length;
        window.dispatchEvent(new Event('focus')); expect(api.put).toHaveBeenCalledTimes(count); render(false); expect(api.put).toHaveBeenCalledTimes(count);
    });
});
