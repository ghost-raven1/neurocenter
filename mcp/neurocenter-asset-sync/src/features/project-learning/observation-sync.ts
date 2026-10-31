import { readState, type Workspace } from '../../bridge/state.js';
import { projectBindingId, projectInstanceId } from '../../bridge/workspace.js';
import { flushLearningObservations } from './observation-queue.js';

/** A background pass never scans arbitrary folders and spends at most four network attempts. */
export async function synchronizeLearningObservations(): Promise<void> {
    const workspace = await readState<Workspace>('workspace');
    let budget = 4;
    for (const projectId of Object.keys(workspace?.bindings ?? {})) {
        if (budget < 1) break;
        try {
            const target = {
                projectId,
                bindingId: await projectBindingId(projectId),
                instanceId: await projectInstanceId(projectId),
            };
            const sent = await flushLearningObservations(target, undefined, 1);
            if (sent) budget--;
        } catch {
            // Errors leave durable observations untouched, including a revoked or changed binding.
            budget--;
        }
    }
}
