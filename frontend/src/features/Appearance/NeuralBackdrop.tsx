import './NeuralBackdrop.less';

const hubs = [[170,170],[510,110],[900,180],[1270,120],[330,440],[730,400],[1150,460],[130,740],[550,780],[940,740],[1350,800]];
const satellites = hubs.flatMap(([x,y], hub) => [0,1,2].map(branch => {
    const angle = hub * .6 + branch * 2.094, distance = 75 + branch * 18;
    return [Math.max(32, Math.min(1408, x + Math.cos(angle) * distance)), Math.max(40, Math.min(920, y + Math.sin(angle) * distance))];
}));
const neurons = [...hubs, ...satellites];
const edges = [[0,1],[0,4],[0,7],[1,2],[1,4],[1,5],[2,3],[2,5],[2,6],[3,6],[4,5],[4,7],[4,8],[5,6],[5,8],[5,9],[6,9],[6,10],[7,8],[8,9],[9,10],
    ...hubs.flatMap((_, hub) => [0,1,2].map(branch => [hub, hubs.length + hub * 3 + branch])),
    ...hubs.flatMap((_, hub) => [0,1].map(branch => [hubs.length + hub * 3 + branch, hubs.length + hub * 3 + branch + 1]))];
const connection = (from: number[], to: number[]) => {
    const dx = to[0] - from[0], dy = to[1] - from[1];
    return `M${from[0]} ${from[1]}C${from[0] + dx * .45 - dy * .15} ${from[1] + dy * .15} ${to[0] - dx * .35 + dy * .12} ${to[1] - dy * .2} ${to[0]} ${to[1]}`;
};

/** Decorative neural field uses a fixed, small vector graph; no timers, pointer handlers or canvas loop. */
export function NeuralBackdrop(): JSX.Element {
    return <div className="neural-backdrop" aria-hidden="true"><svg viewBox="0 0 1440 960" fill="none" preserveAspectRatio="xMidYMid slice">
        <g className="neural-backdrop__connections">{edges.map(([a,b]) => <path key={a+'-'+b} d={connection(neurons[a], neurons[b])}/>)}</g>
        <g className="neural-backdrop__signals">{edges.filter((_, index) => index % 4 === 0).map(([a,b], index) => <path key={a+'-'+b} d={connection(neurons[a], neurons[b])} pathLength="100" style={{animationDelay: `${-index * .43}s`, animationDuration: `${5 + index % 3}s`}}/>)}</g>
        {neurons.map(([x,y], index) => <g key={index} transform={`translate(${x} ${y})`}>
            <g className="neural-backdrop__dendrites">{(index < hubs.length ? [0,1,2,3,4] : [0,2]).map(branch => { const angle = branch * 1.256 + index * .7, dx = Math.cos(angle), dy = Math.sin(angle), size = index < hubs.length ? 1 : .55; return <path key={branch} d={`M0 0Q${(dx*20-dy*8)*size} ${(dy*20+dx*8)*size} ${dx*54*size} ${dy*54*size}m${-dx*22*size} ${-dy*22*size}q${dy*15*size} ${-dx*15*size} ${dy*27*size} ${-dx*30*size}`}/>; })}</g>
            {index < hubs.length && <circle className="neural-backdrop__halo" r="22" style={{animationDelay:`${-index * .43}s`}}/>}
            <circle className={`neural-backdrop__soma${index < hubs.length ? ' neural-backdrop__soma--hub' : ''}`} r={index < hubs.length ? 4.5 : 2.5} style={{animationDelay:`${-index * .43}s`}}/>
        </g>)}
    </svg></div>;
}
