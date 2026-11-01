/** Display a receipt date with a readable fallback for invalid values. */
export const agentTrialDate = (value: string): string =>
    Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('ru-RU') : 'Время не указано';
