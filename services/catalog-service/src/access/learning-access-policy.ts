const item = '[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}';
const reads = new RegExp(
    '^learning(?:/(?:context|history|requests/' +
        item +
        '|(?:experiences|hypotheses|candidates)(?:/' +
        item +
        ')?|hypotheses/' +
        item +
        '/checks(?:/' +
        item +
        ')?|analyses/(?:requests/' +
        item +
        '|' +
        item +
        ')))?$',
);
const reports = new RegExp('^learning/(?:experiences|hypotheses|candidates|analyses|hypotheses/' + item + '/checks)$');
const decisions = new RegExp('^learning/candidates/' + item + '/(?:approve|reject|revoke|activate)$');
/** Unknown learning routes never inherit a broader project's administrative fallback. */
export function allowLearningRoute(level: number, method: string, tail: string): boolean {
    if (['GET', 'HEAD'].includes(method)) return level >= 1 && reads.test(tail);
    if (method !== 'POST') return false;
    return reports.test(tail) ? level >= 2 : decisions.test(tail) && level >= 3;
}
