import path from 'node:path';
import type { IBackgroundAgentContext, TBackgroundAgentContextSource } from '../../../shared/background-agent.cjs';

/**
 * FR-305 task-context seam: a provider turns a payload context descriptor (payload.context[source])
 * into rendered session context for the task. The provider set is the extension seam:
 * - `project` ships: resolves the project working directory and describes what is available there.
 * - `computer` is a seam: resolving it requires the device bridge; without one the provider fails
 *   explicitly (never silently), per FR-305 «нет моста → явная ошибка».
 * - `web` ships: the runtime's web tools are the access path; the descriptor states that.
 * Adding a source = extend BACKGROUND_AGENT_CONTEXT_SOURCES in the contract + a provider here.
 */
export interface IContextDescriptor {
    source: TBackgroundAgentContextSource;
    /** Rendered into the task prompt; bounded plain text, no secrets. */
    rendered: string;
}

export interface IContextProvider {
    readonly source: TBackgroundAgentContextSource;
    prepare(projectId: string, descriptor: Record<string, unknown> | undefined): Promise<IContextDescriptor>;
}

export class BackgroundContextError extends Error {}

/** The project working directory under PROJECTS_ROOT; the task runs there. */
export const defaultProjectsRoot = (): string => process.env.PROJECTS_ROOT ?? '/data/projects';
export const defaultRootForProject = (projectId: string): string => path.resolve(defaultProjectsRoot(), projectId);

/** Describes the project working directory; the root itself is resolved by TaskContext (single source). */
export class ProjectContextProvider implements IContextProvider {
    readonly source = 'project' as const;
    constructor(private readonly projectsRoot: () => string = defaultProjectsRoot) {}
    async prepare(projectId: string): Promise<IContextDescriptor> {
        return {
            source: 'project',
            rendered: `Project working directory: ${path.resolve(this.projectsRoot(), projectId)}`,
        };
    }
}

/**
 * Computer context (FR-305) is resolved through the device bridge; the bridge is not part of this
 * epic's boundary. The provider exists as the seam and fails explicitly when the bridge is absent —
 * a task that asked for computer context is never served without it.
 */
export class ComputerContextProvider implements IContextProvider {
    readonly source = 'computer' as const;
    constructor(private readonly bridgeAvailable: () => boolean = () => false) {}
    async prepare(): Promise<IContextDescriptor> {
        if (!this.bridgeAvailable())
            throw new BackgroundContextError(
                'Компьютерный контекст недоступен: мост к устройству не настроен. Уберите источник context.computer из задачи или настройте мост.',
            );
        return { source: 'computer', rendered: 'Computer context is provided by the device bridge.' };
    }
}

/** Web access goes through the runtime's web tools; the descriptor only states the selection. */
export class WebContextProvider implements IContextProvider {
    readonly source = 'web' as const;
    async prepare(): Promise<IContextDescriptor> {
        return { source: 'web', rendered: 'Web access is enabled through the runtime web tools.' };
    }
}

/** Resolves the requested context sources into rendered descriptors (fail-closed on any provider error). */
export class TaskContext {
    private readonly providers = new Map<TBackgroundAgentContextSource, IContextProvider>();
    private readonly rootResolver: (projectId: string) => string;
    constructor(
        providers: IContextProvider[] = [],
        rootResolver: (projectId: string) => string = defaultRootForProject,
    ) {
        for (const provider of providers) this.providers.set(provider.source, provider);
        this.rootResolver = rootResolver;
    }
    /** The default selection when the payload names no context: project only. */
    static defaults(): TaskContext {
        return new TaskContext([new ProjectContextProvider(), new ComputerContextProvider(), new WebContextProvider()]);
    }
    provider(source: TBackgroundAgentContextSource): IContextProvider | undefined {
        return this.providers.get(source);
    }
    /** The absolute working directory the task runs in (the runtime root). */
    root(projectId: string): string {
        return this.rootResolver(projectId);
    }
    async prepare(
        projectId: string,
        context: IBackgroundAgentContext | undefined,
    ): Promise<{ descriptors: IContextDescriptor[]; root: string }> {
        const sources = Object.keys(context ?? {});
        const requested = sources.length ? sources : ['project'];
        const descriptors: IContextDescriptor[] = [];
        for (const rawSource of requested) {
            const source = rawSource as TBackgroundAgentContextSource;
            const provider = this.providers.get(source);
            if (!provider) throw new BackgroundContextError(`Контекстный источник «${rawSource}» не настроен.`);
            descriptors.push(await provider.prepare(projectId, context?.[source]));
        }
        return { descriptors, root: this.rootResolver(projectId) };
    }
}
