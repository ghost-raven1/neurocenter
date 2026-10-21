const rules = new Intl.PluralRules('ru');
const forms = {hypotheses: ['гипотеза', 'гипотезы', 'гипотез'], knowledge: ['действующее знание', 'действующих знания', 'действующих знаний']} as const;

/** Russian count labels keep singular and compound numbers readable. */
export function learningCountLabel(count: number, kind: keyof typeof forms): string {
    const plural = rules.select(count);
    return forms[kind][plural === 'one' ? 0 : plural === 'few' ? 1 : 2];
}
