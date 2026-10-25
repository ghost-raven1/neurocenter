// @vitest-environment jsdom
import {act, createElement, StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {expect, it, vi} from 'vitest';
import {useChatRoleAction} from '../src/features/ChatSystemRoles/useChatRoleAction';
import {ChatSendAction} from '../src/features/ChatCommon/ChatSendAction';

it('ignores stale task registration and cleanup after an origin change, including StrictMode replay', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
    let controls!: ReturnType<typeof useChatRoleAction>;
    function Host({owner}: {owner: string}) {controls = useChatRoleAction(owner); return <ChatSendAction task={controls.action} disabled onSend={() => undefined}/>;}
    const container = document.createElement('div'), root = createRoot(container); document.body.appendChild(container);
    const render = async (owner: string) => act(async () => {root.render(createElement(StrictMode,null,createElement(Host,{owner})));});
    try {
        await render('alice:project-one:task-one'); const old = controls.register;
        await act(async () => {old({label: 'Old task',disabled: false,busy: false,onClick: vi.fn()});}); expect(container.textContent).toContain('Old task');
        await render('alice:project-two:task-two'); expect(container.textContent).not.toContain('Old task');
        await act(async () => {controls.register({label: 'Current task',disabled: false,busy: false,onClick: vi.fn()});});
        await act(async () => {old(undefined); old({label: 'Late old task',disabled: false,busy: false,onClick: vi.fn()});});
        expect(container.textContent).toContain('Current task'); expect(container.textContent).not.toContain('Late old task');
    } finally {await act(async () => {root.unmount();}); container.remove(); vi.unstubAllGlobals();}
});
