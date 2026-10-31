import { memoryDigest, MEMORY_SYNC_LIMITS as limits, type MemoryEntity } from './contract.js';
import type { MemoryPort } from './memory-client.js';

interface Step {
    kind: 'create' | 'add' | 'remove';
    name: string;
    before: MemoryEntity | undefined;
    after: MemoryEntity;
    values: string[];
    state: 'pending' | 'intent' | 'done';
}
export interface ProjectionJournal {
    schemaVersion: 1;
    namespace: string;
    owned: Record<string, MemoryEntity>;
    plan?: { digest: string; steps: Step[] };
}
const conflict = () =>
    Object.assign(new Error('Управляемая запись Memory изменена вне сохранённого плана. Ручные данные сохранены.'), {
        code: 'conflict',
    });
const quota = () =>
    Object.assign(new Error('План Memory превышает допустимый объём. Уменьшите объём и повторите.'), { code: 'quota' });
const includes = (node: MemoryEntity | undefined, owned: MemoryEntity) =>
    !!node &&
    node.entityType === owned.entityType &&
    owned.observations.every((value) => node.observations.includes(value));
const same = (a: MemoryEntity | undefined, b: MemoryEntity) => !!a && memoryDigest(a) === memoryDigest(b);

/** A corrupt private receipt cannot turn a managed retry into writes outside its namespace. */
export function assertProjectionJournal(value: ProjectionJournal, namespace: string): void {
    const entity = (item: MemoryEntity | undefined, name: string) =>
        !!item &&
        item.name === name &&
        name.startsWith(namespace) &&
        item.entityType === 'neurocenter.approved-project-knowledge.v1' &&
        Array.isArray(item.observations) &&
        item.observations.length <= limits.observationsPerEntity &&
        new Set(item.observations).size === item.observations.length &&
        item.observations.every(
            (text) => typeof text === 'string' && Buffer.byteLength(text) <= limits.ownedObservationBytes,
        );
    if (
        !value ||
        value.schemaVersion !== 1 ||
        value.namespace !== namespace ||
        !value.owned ||
        typeof value.owned !== 'object' ||
        Array.isArray(value.owned) ||
        Object.keys(value.owned).length > limits.entities ||
        Object.entries(value.owned).some(([name, item]) => !entity(item, name)) ||
        Buffer.byteLength(JSON.stringify(value)) > limits.journalBytes
    )
        throw conflict();
    if (
        value.plan &&
        (!/^[a-f0-9]{64}$/.test(value.plan.digest) ||
            !Array.isArray(value.plan.steps) ||
            value.plan.steps.length > limits.stepsPerJob ||
            Buffer.byteLength(JSON.stringify(value.plan.steps)) > limits.planBytes ||
            value.plan.steps.some(
                (step) =>
                    !step ||
                    !['create', 'add', 'remove'].includes(step.kind) ||
                    !['pending', 'intent', 'done'].includes(step.state) ||
                    !entity(step.after, step.name) ||
                    (step.before !== undefined && !entity(step.before, step.name)) ||
                    !Array.isArray(step.values) ||
                    step.values.length > limits.observationsPerEntity ||
                    step.values.some(
                        (text) => typeof text !== 'string' || Buffer.byteLength(text) > limits.ownedObservationBytes,
                    ) ||
                    (step.kind === 'create' ? step.before !== undefined : !step.before) ||
                    step.values.some(
                        (text) => !(step.kind === 'remove' ? step.before! : step.after).observations.includes(text),
                    ),
            ))
    )
        throw conflict();
    if (value.plan) {
        const next = new Map(Object.entries(value.owned)),
            lastDone = new Map<string, MemoryEntity>();
        let pending = false;
        for (const step of value.plan.steps) {
            if (step.state === 'done') {
                if (pending) throw conflict();
                lastDone.set(step.name, step.after);
                continue;
            }
            pending = true;
            const before = next.get(step.name);
            if (step.kind === 'create' ? before !== undefined : !before || !same(before, step.before!))
                throw conflict();
            const observations =
                step.kind === 'create'
                    ? step.values
                    : step.kind === 'add'
                      ? [...new Set([...step.before!.observations, ...step.values])]
                      : step.before!.observations.filter((text) => !step.values.includes(text));
            if (memoryDigest({ ...step.after, observations }) !== memoryDigest(step.after)) throw conflict();
            next.set(step.name, step.after);
        }
        for (const [name, entity] of lastDone) if (!same(value.owned[name], entity)) throw conflict();
    }
}

/** Preserve unrelated observations and all relations: revocation removes only recorded owned strings. */
export async function projectMemory(
    port: MemoryPort,
    journal: ProjectionJournal,
    desired: MemoryEntity[],
    planDigest: string,
    cleanup: boolean,
    save: (journal: ProjectionJournal) => Promise<void>,
    authorize: () => Promise<unknown>,
    checkpoint: (applied: number, removed: number, remaining: number) => Promise<void>,
) {
    assertProjectionJournal(journal, journal.namespace);
    if (
        new Set([...Object.keys(journal.owned), ...desired.map((entity) => entity.name)]).size > limits.entities ||
        desired.length > limits.activeEntries
    )
        throw quota();
    if (
        new Set(desired.map((entity) => entity.name)).size !== desired.length ||
        desired.some((entity) => !entity.name.startsWith(journal.namespace))
    )
        throw conflict();
    if (
        desired.some(
            (entity) =>
                entity.observations.length > limits.observationsPerEntity ||
                entity.observations.some((text) => Buffer.byteLength(text) > limits.ownedObservationBytes),
        )
    )
        throw quota();
    const node = async (name: string) => {
        const found = await port.nodes([name]);
        return found[0];
    };
    // A previous unacknowledged mutation can be inspected without reapplying an obsolete approved snapshot.
    if (journal.plan && journal.plan.digest !== planDigest) {
        for (const step of journal.plan.steps.filter((item) => item.state === 'intent')) {
            const actual = await node(step.name);
            if (step.kind === 'remove') {
                const remaining =
                    step.before?.observations.filter((value) => actual?.observations.includes(value)) ?? [];
                journal.owned[step.name] = { ...step.after, observations: remaining };
            } else if (includes(actual, step.after)) journal.owned[step.name] = step.after;
            else if (step.before && includes(actual, step.before)) journal.owned[step.name] = step.before;
            else if (actual) throw conflict();
        }
        journal.plan = undefined;
        await save(journal);
    }
    if (!journal.plan) {
        const steps: Step[] = [],
            wanted = new Map(desired.map((entity) => [entity.name, entity]));
        for (const after of desired) {
            const before = journal.owned[after.name];
            if (cleanup) {
                const removed = before?.observations.filter((value) => !after.observations.includes(value)) ?? [];
                if (before && removed.length)
                    steps.push({
                        kind: 'remove',
                        name: before.name,
                        before,
                        after: {
                            ...before,
                            observations: before.observations.filter((value) => after.observations.includes(value)),
                        },
                        values: removed,
                        state: 'pending',
                    });
                continue;
            }
            if (before && same(before, after)) continue;
            if (!before)
                steps.push({
                    kind: 'create',
                    name: after.name,
                    before: undefined,
                    after,
                    values: after.observations,
                    state: 'pending',
                });
            else {
                const added = after.observations.filter((value) => !before.observations.includes(value));
                const combined = { ...after, observations: [...new Set([...before.observations, ...added])] };
                if (added.length)
                    steps.push({
                        kind: 'add',
                        name: after.name,
                        before,
                        after: combined,
                        values: added,
                        state: 'pending',
                    });
                const removed = before.observations.filter((value) => !after.observations.includes(value));
                if (removed.length)
                    steps.push({
                        kind: 'remove',
                        name: after.name,
                        before: combined,
                        after,
                        values: removed,
                        state: 'pending',
                    });
            }
        }
        for (const before of Object.values(journal.owned))
            if (!wanted.has(before.name) && before.observations.length)
                steps.push({
                    kind: 'remove',
                    name: before.name,
                    before,
                    after: { ...before, observations: [] },
                    values: before.observations,
                    state: 'pending',
                });
        if (steps.length > limits.stepsPerJob || Buffer.byteLength(JSON.stringify(steps)) > limits.planBytes)
            throw quota();
        journal.plan = { digest: planDigest, steps };
        if (Buffer.byteLength(JSON.stringify(journal)) + 1024 > limits.journalBytes) throw quota();
    }
    // Inspect unchanged records too: a completed receipt is not proof that Memory still contains them.
    // All reads and quota checks precede writes, including an explicit retry of an interrupted plan.
    const names = [
        ...new Set([
            ...Object.keys(journal.owned),
            ...desired.map((entity) => entity.name),
            ...journal.plan.steps.map((step) => step.name),
        ]),
    ];
    const actuals = new Map<string, MemoryEntity>();
    let readBytes = 0;
    for (let index = 0; index < names.length; index += 32) {
        const nodes = await port.nodes(names.slice(index, index + 32));
        readBytes += Buffer.byteLength(JSON.stringify(nodes));
        if (readBytes > limits.readResponseBytes) throw quota();
        for (const entity of nodes) actuals.set(entity.name, entity);
    }
    const uncertain = new Set(journal.plan.steps.filter((step) => step.state === 'intent').map((step) => step.name));
    for (const owned of Object.values(journal.owned))
        if (owned.observations.length && !uncertain.has(owned.name) && !includes(actuals.get(owned.name), owned))
            throw conflict();
    for (const step of journal.plan.steps)
        if (step.kind === 'create' && step.state === 'pending' && actuals.has(step.name)) throw conflict();
    await save(journal);
    const steps = journal.plan.steps;
    const progress = () => ({
        applied: steps.filter((step) => step.state === 'done' && step.kind !== 'remove').length,
        removed: steps.filter((step) => step.state === 'done' && step.kind === 'remove').length,
        remaining: steps.filter((step) => step.state !== 'done').length,
    });
    const initial = progress();
    await checkpoint(initial.applied, initial.removed, initial.remaining);
    for (const step of steps) {
        if (step.state === 'done') continue;
        await authorize();
        let actual = await node(step.name);
        const already =
            step.kind === 'remove'
                ? !actual || step.values.every((value) => !actual!.observations.includes(value))
                : includes(actual, step.after);
        if (step.state === 'intent' && already) {
            step.state = 'done';
            journal.owned[step.name] = step.after;
            await save(journal);
            const p = progress();
            await checkpoint(p.applied, p.removed, p.remaining);
            continue;
        }
        if (step.kind === 'create' ? actual !== undefined : !step.before || !includes(actual, step.before))
            throw conflict();
        if (step.state !== 'intent') {
            step.state = 'intent';
            await save(journal);
        }
        await authorize();
        if (step.kind === 'create') await port.create(step.after);
        else if (step.kind === 'add') await port.add(step.name, step.values);
        else await port.remove(step.name, step.values);
        actual = await node(step.name);
        if (
            step.kind === 'remove'
                ? actual && step.values.some((value) => actual!.observations.includes(value))
                : !includes(actual, step.after)
        )
            throw new Error('Memory не подтвердил сохранённую мутацию.');
        step.state = 'done';
        journal.owned[step.name] = step.after;
        await save(journal);
        const p = progress();
        await checkpoint(p.applied, p.removed, p.remaining);
    }
    return progress();
}
