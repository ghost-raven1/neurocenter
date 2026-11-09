/**
 * Deadline ladders (AD-6, entry 9): every nested transport budget derives from
 * `base + margins` so an enclosing deadline can never be equal to or tighter
 * than the one it wraps.
 *
 * `deadlineLadder(name, baseMs, margins)` returns the ladder as an array:
 * levels[0] = baseMs (innermost / server), levels[i] = levels[i-1] + margins[i-1].
 * A zero margin throws `pair equal: {name} {value}` so the invariant test fails
 * loudly instead of passing with an inverted or tied ladder.
 */

/** @param {string} name @param {number} baseMs @param {number[]} margins @returns {number[]} */
export function deadlineLadder(name, baseMs, margins) {
    if (typeof name !== 'string' || name.length === 0)
        throw new Error('deadline-ladders: name — непустая строка, получено ' + String(name));
    if (!Number.isInteger(baseMs) || baseMs <= 0)
        throw new Error('deadline-ladders: ' + name + ' base — положительный integer ms, получено ' + String(baseMs));
    if (!Array.isArray(margins))
        throw new Error('deadline-ladders: ' + name + ' margins — массив, получен ' + String(margins));
    const levels = [baseMs];
    for (let i = 0; i < margins.length; i++) {
        const margin = margins[i];
        if (!Number.isInteger(margin))
            throw new Error('deadline-ladders: ' + name + ' margin[' + i + '] — integer ms, получен ' + String(margin));
        if (margin === 0) throw new Error('pair equal: ' + name + ' ' + levels[i]);
        if (margin < 0)
            throw new Error('deadline-ladders: ' + name + ' margin[' + i + '] — положительный ms, получен ' + String(margin));
        levels.push(levels[i] + margin);
    }
    return levels;
}
