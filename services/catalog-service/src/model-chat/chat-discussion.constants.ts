/** A discussion is one private turn, never an administrative agent or a recursive task tree. */
export const DISCUSSION_LIMITS = Object.freeze({
    calls: 5,
    depth: 1,
    contributions: 3,
    deadlineMs: 120000,
    stepMs: 40000,
    reserveMs: 2000,
    outputBytes: 16384,
});
