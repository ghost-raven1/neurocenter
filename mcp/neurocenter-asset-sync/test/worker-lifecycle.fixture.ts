import {expect,vi} from 'vitest';

type SignalListeners=Map<NodeJS.Signals,Set<(...args:unknown[])=>void>>;

/** Await the worker's shutdown before restoring its network boundary and environment. */
export async function stopFixtureWorker(previous:SignalListeners):Promise<void>{
    const stop=process.listeners('SIGTERM').find(listener=>!previous.get('SIGTERM')?.has(listener));
    if(!stop)return;
    if(!vi.isMockFunction(process.exit))throw new Error('Worker fixture must replace process.exit before starting.');
    if(!process.exit.mock.calls.length)stop();
    await vi.waitFor(()=>expect(process.exit).toHaveBeenCalledWith(0));
}
