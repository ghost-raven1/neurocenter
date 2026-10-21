import type {IModelChatParticipant} from './types';

/** Standalone @names are addresses; emails and code within backticks stay ordinary message text. */
export function chatRecipients(prompt: string, participants: IModelChatParticipant[]): {ids: string[]; error?: string} {
    const text = prompt.replace(/```[\s\S]*?```|`[^`]*`/g, ''), ids = new Set<string>();
    for (const match of text.matchAll(/(?:^|[\s([{'"«])@([^\s]*)/gu)) {
        const token = match[1].replace(/[,.!?;:)\]}'"»]+$/gu, '');
        if (!token || !/^[\p{L}\p{N}][\p{L}\p{N}_-]*$/u.test(token)) return {ids: [], error: 'Завершите @адресата: выберите имя из подсказки.'};
        const name = token.toLocaleLowerCase('ru'), values = participants.filter(agent => agent.slug.toLocaleLowerCase('ru') === name || agent.name.toLocaleLowerCase('ru') === name);
        if (values.length !== 1) return {ids: [], error: `Адресат @${token} ${values.length ? 'неоднозначен' : 'не найден среди участников'}. Выберите имя из подсказки.`};
        if (values[0].status !== 'active') return {ids: [], error: `${values[0].name}: ${values[0].reason || 'агент недоступен'}. Измените участников или адресатов.`};
        ids.add(values[0].agentId);
    }
    if (!ids.size && !participants.some(agent => agent.status === 'active')) return {ids: [], error: 'Добавьте хотя бы одного доступного агента.'};
    if (!ids.size && participants.some(agent => agent.status !== 'active')) return {ids: [], error: 'Среди участников есть недоступные агенты. Уберите их или обратитесь к доступным через @имя.'};
    return {ids: [...ids]};
}
