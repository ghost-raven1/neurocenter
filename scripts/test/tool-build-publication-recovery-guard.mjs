/** Any still-present observed PID blocks stop proof, even after group change or PID reuse. */
export function remainingObservedPids(known,rows){
    return [...known.keys()].filter(pid=>rows.has(pid)).sort((left,right)=>left-right);
}
