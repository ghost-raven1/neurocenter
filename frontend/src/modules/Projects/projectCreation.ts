/** Поздний ответ создания не уведомляет и не перенаправляет другого владельца формы. */
export async function submitProjectCreation(options: {
    isCurrent: () => boolean;
    create: () => Promise<{ id: string }>;
    onCreated: (id: string) => void;
    onError: (error: unknown) => void;
}): Promise<void> {
    if (!options.isCurrent()) { return; }
    try {
        const project = await options.create();
        if (options.isCurrent()) { options.onCreated(project.id); }
    } catch (error) {
        if (options.isCurrent()) { options.onError(error); }
    }
}
