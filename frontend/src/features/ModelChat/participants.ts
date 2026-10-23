import type {IModelChatParticipant} from './types';

/** Parse explicit standalone @addresses without applying a room's default delivery policy. */
export function chatMentions(prompt: string, participants: IModelChatParticipant[]): {ids: string[]; hasMentions: boolean; error?: string} {
    const text = prompt.replace(/```[\s\S]*?```|`[^`]*`/g, ''), ids = new Set<string>(); let hasMentions = false;
    for (const match of text.matchAll(/(?:^|[\s([{'"«])@([^\s]*)/gu)) {
        const token = match[1].replace(/[,.!?;:)\]}'"»]+$/gu, '');
        hasMentions = true;
        if (!token || !/^[\p{L}\p{N}][\p{L}\p{N}_-]*$/u.test(token)) return {ids: [], hasMentions, error: 'Завершите @адресата: выберите имя из подсказки.'};
        const name = token.toLocaleLowerCase('ru'), slugs = participants.filter(agent => agent.slug.toLocaleLowerCase('ru') === name);
        const values = slugs.length ? slugs : participants.filter(agent => agent.name.toLocaleLowerCase('ru') === name);
        if (values.length !== 1) return {ids: [], hasMentions, error: `Адресат @${token} ${values.length ? 'неоднозначен' : 'не найден среди участников'}. Выберите имя из подсказки.`};
        if (values[0].status !== 'active') return {ids: [], hasMentions, error: `${values[0].name}: ${values[0].reason || 'агент недоступен'}. Измените участников или адресатов.`};
        ids.add(values[0].agentId);
    }
    return {ids: [...ids], hasMentions};
}

/** Private groups retain their existing broadcast/default eligibility independently of explicit parsing. */
export function chatRecipients(prompt: string, participants: IModelChatParticipant[]): {ids: string[]; error?: string} {
    const {ids, error} = chatMentions(prompt, participants);
    if (error) return {ids: [], error};
    if (!ids.length && !participants.some(agent => agent.status === 'active')) return {ids: [], error: 'Добавьте хотя бы одного доступного агента.'};
    if (!ids.length && participants.some(agent => agent.status !== 'active')) return {ids: [], error: 'Среди участников есть недоступные агенты. Уберите их или обратитесь к доступным через @имя.'};
    return {ids};
}
