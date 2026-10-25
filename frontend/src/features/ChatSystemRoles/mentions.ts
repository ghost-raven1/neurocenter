import type { IModelChatParticipant } from '../ModelChat/types';
import type { SystemRoleId } from '../SystemRoles/types';

export const chatSystemRoleOptions: Array<{value: string; label: string; agentId: SystemRoleId; aliases: string[]}> = [
    {value: 'sys-coordinator', label: 'Координатор · системный', agentId: 'agent-coordinator', aliases: ['координатор']},
    {value: 'sys-ai-admin', label: 'AI-админ · системный', agentId: 'agent-ai-admin', aliases: ['ai-админ']},
    {value: 'sys-autoconfigurator', label: 'Автоконфигуратор · системный', agentId: 'agent-autoconfigurator', aliases: ['автоконфигуратор']},
    {value: 'sys-indexer', label: 'Индексатор · системный', agentId: 'agent-indexer', aliases: ['индексатор']},
    {value: 'sys-packager', label: 'Упаковщик · системный', agentId: 'agent-packager', aliases: ['упаковщик']},
];
export interface ChatSystemRoleMention {agentId?: SystemRoleId; instruction: string; error?: string;}

/** System mentions open one consented task; they never become ordinary agent recipients. */
export function chatSystemRoleMention(body: string, participants: IModelChatParticipant[] = []): ChatSystemRoleMention {
    const text = body.replace(/```[\s\S]*?```|`[^`]*`/g, match => ' '.repeat(match.length));
    const mentions = [...text.matchAll(/(?:^|[\s([{'"«])@([^\s]*)/gu)], roles = new Set<SystemRoleId>(), spans: Array<[number, number]> = [];
    let ordinary = false;
    for (const mention of mentions) {
        const token = mention[1].replace(/[,.!?;:)\]}'"»]+$/gu, ''), name = token.toLocaleLowerCase('ru');
        const selected = chatSystemRoleOptions.find(option => option.value === name || option.aliases.includes(name));
        if (!selected) {
            if (name.startsWith('sys-')) return {instruction: body, error: 'Системный агент не найден. Выберите имя из подсказки; текст сохранён.'};
            ordinary = true; continue;
        }
        if (participants.some(item => [item.slug, item.name].some(value => value.toLocaleLowerCase('ru') === name))) {
            return {instruction: body, error: `Адресат @${token} неоднозначен. Выберите системного агента @${selected.value} из подсказки.`};
        }
        roles.add(selected.agentId);
        const start = mention.index! + mention[0].indexOf('@'); spans.push([start, start + token.length + 1]);
    }
    if (!roles.size) return {instruction: body};
    if (ordinary) return {instruction: body, error: 'Отправьте системную задачу отдельно от сообщения обычным участникам. Текст сохранён.'};
    if (roles.size > 1) return {instruction: body, error: 'Выберите одного системного агента или Координатора для общей задачи.'};
    let instruction = body;
    for (const [start, end] of spans.reverse()) instruction = instruction.slice(0, start) + instruction.slice(end);
    return {agentId: [...roles][0], instruction: instruction.trim()};
}
