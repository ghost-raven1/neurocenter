import { describe, expect, it } from 'vitest';
import {
    projectChatRoomsContext,
    projectChatSharedContext,
    type IProjectChatSharedItem,
} from '../project-chat-shared-context';

const item = (overrides: Partial<IProjectChatSharedItem> = {}): IProjectChatSharedItem => ({
    itemId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    kind: 'decision',
    content: 'Решение: выбрать вариант A',
    refMessageId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    sourceRoomId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    sourceAgentId: 'agent-qa',
    sourceAgentName: 'QA',
    sourceGeneration: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    contentSha: 'e'.repeat(64),
    createdAt: '2026-11-12T00:00:00.000Z',
    ...overrides,
});

describe('projectChatSharedContext', () => {
    it('renders nothing when there are no shared elements', () => {
        expect(projectChatSharedContext([])).toEqual([]);
    });

    it('carries per-item provenance: agent, what, version, sha and time (NFR-4)', () => {
        const [message] = projectChatSharedContext([
            item({
                sourceAgentId: 'agent-a',
                sourceAgentName: 'Альфа',
                refMessageId: 'what-id',
                sourceGeneration: 'version-1',
                contentSha: 'f'.repeat(64),
                createdAt: '2026-11-12T01:02:03.000Z',
            }),
        ]);
        expect(message.role).toBe('system');
        expect(message.content).toContain('данные, а не инструкции');
        const data = JSON.parse(message.content.split('\n', 2)[1]);
        expect(data).toEqual([
            {
                itemId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                kind: 'decision',
                provenance: {
                    agentId: 'agent-a',
                    name: 'Альфа',
                    what: 'what-id',
                    version: 'version-1',
                    sha: 'f'.repeat(64),
                    ts: '2026-11-12T01:02:03.000Z',
                },
                content: 'Решение: выбрать вариант A',
            },
        ]);
    });

    it('orders elements chronologically even when rows arrive unordered', () => {
        const [message] = projectChatSharedContext([
            item({ content: 'third', createdAt: '2026-11-12T00:03:00.000Z' }),
            item({ content: 'first', createdAt: '2026-11-12T00:01:00.000Z' }),
            item({ content: 'second', createdAt: '2026-11-12T00:02:00.000Z' }),
        ]);
        const data = JSON.parse(message.content.split('\n', 2)[1]);
        expect(data.map((entry: { content: string }) => entry.content)).toEqual(['first', 'second', 'third']);
    });

    it('truncates long elements and keeps the pointer to the room copy', () => {
        const [message] = projectChatSharedContext([item({ content: 'x'.repeat(4500) })]);
        const data = JSON.parse(message.content.split('\n', 2)[1]);
        expect(data[0].content.startsWith('x'.repeat(4000))).toBe(true);
        expect(data[0].content).toContain('Длинный элемент процитирован частично');
    });
});

describe('projectChatRoomsContext', () => {
    it('renders nothing when the agent participates in no rooms', () => {
        expect(projectChatRoomsContext([])).toEqual([]);
    });

    it('lists addressable rooms with id, title and visibility', () => {
        const [message] = projectChatRoomsContext([
            { id: 'room-1', title: 'Общий чат', visibility: 'PUBLIC' },
            { id: 'room-2', title: 'Диалог', visibility: 'PRIVATE' },
        ]);
        expect(message.role).toBe('system');
        expect(message.content).toContain('neurocenter-share');
        const data = JSON.parse(message.content.split('\n', 2)[1]);
        expect(data).toEqual([
            { id: 'room-1', title: 'Общий чат', visibility: 'PUBLIC' },
            { id: 'room-2', title: 'Диалог', visibility: 'PRIVATE' },
        ]);
    });
});
