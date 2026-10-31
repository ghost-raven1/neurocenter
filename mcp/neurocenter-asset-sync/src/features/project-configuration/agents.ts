import { agentsPrivateProof, AGENTS_RECEIPT, agentFile } from '../project-agents/receipt.js';
import type { InstallationPlan } from '../../bridge/installation-plan.js';
import { hash } from '../../bridge/state.js';
import type { ConfigurationContext } from './context.js';
const begin = '<!-- neurocenter:agents:start -->',
    end = '<!-- neurocenter:agents:end -->';
/** Only names and paths from byte-verified site-owned files enter the explicit managed section. */
export async function agentSection(
    context: ConfigurationContext,
    plan: InstallationPlan,
    raw: string | null,
): Promise<string> {
    const proof = await agentsPrivateProof(context.root, context.descriptor.projectId);
    if (
        !proof ||
        proof.receipt.bindingId !== context.descriptor.bindingId ||
        proof.receipt.instanceId !== context.descriptor.instanceId ||
        (await plan.read(AGENTS_RECEIPT)) !== proof.raw
    )
        throw Error('Сначала примените агентов сайта к этой папке.');
    const names: string[] = [];
    for (const agent of proof.receipt.agents) {
        const relative = agentFile(agent.slug),
            text = await plan.read(relative);
        if (text === null || hash(text) !== agent.sha256)
            throw Error('Файл агента изменён вручную. Сначала восстановите его через сайт.');
        if (agent.enabled) names.push('- `' + agent.slug + '` — `' + relative + '`');
    }
    const text = raw ?? '',
        newline = text.includes('\r\n') ? '\r\n' : '\n';
    const section = [
        begin,
        '## Агенты Neurocenter',
        '',
        ...(names.length ? names : ['В проекте нет включённых агентов сайта.']),
        end,
    ].join(newline);
    const start = text.indexOf(begin),
        finish = text.indexOf(end);
    if (start < 0 && finish < 0)
        return text + (text && !text.endsWith('\n') ? newline : '') + (text ? newline : '') + section + newline;
    if (
        start < 0 ||
        finish < start ||
        text.indexOf(begin, start + begin.length) >= 0 ||
        text.indexOf(end, finish + end.length) >= 0
    )
        throw Error('Маркеры раздела агентов конфликтуют. Исправьте их вручную перед обновлением.');
    return text.slice(0, start) + section + text.slice(finish + end.length);
}
