import {Tooltip} from 'antd';
import type {ProjectChatActivity} from './activity.types';
import type {ProjectChatMember} from './types';

/** People have presence; agent availability is deliberately shown separately. */
export function ProjectChatPresence({email, activity, connected, enabled}: {email: string; activity?: ProjectChatActivity; connected: boolean; enabled: boolean}): JSX.Element | null {
    if (!enabled) return null;
    const member = connected ? activity?.members.find(value => value.email === email) : undefined;
    const text = member ? member.online ? 'В сети' : 'Не в сети' : 'Статус неизвестен';
    return <span className={`project-chat__presence${member?.online ? ' project-chat__presence_online' : ''}`} aria-label={text}>{text}</span>;
}

export function ProjectChatTyping({activity, members, connected, enabled}: {activity?: ProjectChatActivity; members: ProjectChatMember[]; connected: boolean; enabled: boolean}): JSX.Element | null {
    const people = connected && enabled ? activity?.members.filter(member => member.typing && member.email !== activity.viewerEmail).map(member => members.find(value => value.email === member.email)?.displayName || member.email) ?? [] : [];
    return <div className="project-chat__typing" role="status" aria-live="polite">{people.length ? `${people.join(', ')} ${people.length === 1 ? 'печатает' : 'печатают'}…` : ''}</div>;
}

/** Two checks mean saved delivery; color requires at least one other authorized human reader. */
export function ProjectChatSeen({messageId, authorEmail, activity, members}: {messageId: string; authorEmail?: string; activity?: ProjectChatActivity; members: ProjectChatMember[]}): JSX.Element | null {
    if (!activity || authorEmail !== activity.viewerEmail) return null;
    const audience = new Set(activity.members.map(member => member.email));
    const readers = [...new Set(activity.receipts.find(receipt => receipt.messageId === messageId)?.readerEmails ?? [])].filter(email => email !== authorEmail && audience.has(email));
    const names = readers.map(email => members.find(member => member.email === email)?.displayName || email);
    const text = readers.length ? `Просмотрели: ${readers.length} · ${names.join(', ')}` : 'Доставлено · ещё не просмотрено другими участниками';
    return <Tooltip title={text}><span className={`project-chat__seen${readers.length ? ' project-chat__seen_read' : ''}`} role="img" aria-label={text} tabIndex={0}>✓✓</span></Tooltip>;
}
