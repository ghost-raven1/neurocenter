import {harness, renderProjectUi} from './project-chat-ui-fixture';
import {afterEach, describe, expect, it} from 'vitest';
import {ProjectChatPresence, ProjectChatSeen, ProjectChatTyping} from '../src/features/ProjectChat/ProjectChatActivity';
import type {ProjectChatActivity} from '../src/features/ProjectChat/activity.types';

const members = [{email: 'alice@example.test', displayName: 'Алиса', role: 'developer'}, {email: 'bob@example.test', displayName: 'Боб', role: 'developer'}];
const activity = (patch: Partial<ProjectChatActivity> = {}): ProjectChatActivity => ({roomId: 'room', viewerEmail: members[0].email, observedAt: new Date().toISOString(), members: [{email: members[0].email, online: true, typing: true}, {email: members[1].email, online: false, typing: true}], receipts: [], ...patch});
afterEach(() => harness.dispose());

describe('Фактические статусы людей в чате', () => {
    it('Потеря связи не превращает человека в офлайн; флаг скрывает live-статус', () => {
        const view = (connected: boolean, enabled = true) => renderProjectUi(() => <ProjectChatPresence email={members[0].email} activity={activity()} connected={connected} enabled={enabled}/>).html;
        expect(view(true)).toContain('В сети'); expect(view(false)).toContain('Статус неизвестен'); expect(view(false)).not.toContain('Не в сети'); expect(view(true, false)).not.toContain('В сети');
    });
    it('Печатает показывает других людей; потеря связи и OFF убирают временный текст', () => {
        const view = (connected: boolean, enabled = true) => renderProjectUi(() => <ProjectChatTyping activity={activity()} members={members} connected={connected} enabled={enabled}/>).html;
        expect(view(true)).toContain('Боб печатает'); expect(view(true)).not.toContain('Алиса печатает'); expect(view(false)).not.toContain('печатает'); expect(view(true, false)).not.toContain('печатает');
    });
    it('Две галочки меняют цвет только после просмотра другим разрешённым человеком', () => {
        const view = (value: ProjectChatActivity, authorEmail = members[0].email) => renderProjectUi(() => <ProjectChatSeen messageId="message" authorEmail={authorEmail} activity={value} members={members}/>).html;
        expect(view(activity())).toContain('✓✓'); expect(view(activity())).not.toContain('project-chat__seen_read');
        expect(view(activity({receipts: [{messageId: 'message', readerEmails: [members[0].email, 'removed@example.test']}]}))).not.toContain('project-chat__seen_read');
        const read = view(activity({receipts: [{messageId: 'message', readerEmails: [members[1].email, members[1].email]}]}));
        expect(read).toContain('project-chat__seen_read'); expect(read).toContain('Просмотрели: 1 · Боб'); expect(view(activity(), members[1].email)).not.toContain('✓✓');
    });
});
