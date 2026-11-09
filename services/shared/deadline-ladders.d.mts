/**
 * Deadline ladders (AD-6, entry 9): nested transport budgets derived from `base + margins`.
 * `levels[0]` is the base (innermost level); each following level adds the next margin
 * (strictly positive). A zero margin throws `pair equal: {name} {value}`; non-integer
 * or non-positive values throw at import/call time.
 */
export function deadlineLadder(name: string, baseMs: number, margins: readonly number[]): number[];
