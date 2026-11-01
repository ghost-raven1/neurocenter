/** Generate a draft slug; unavailable crypto leaves manual input possible. */
export const initialAgentSlug = (): string => {
    try {
        return 'nc-agent-' + crypto.randomUUID().slice(0, 8);
    } catch {
        return '';
    }
};
