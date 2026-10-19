interface IPreparation {
    inProject: boolean;
    canManage: boolean;
    current(): boolean;
    add(): Promise<unknown>;
    refresh(): Promise<unknown>;
}

/** Добавление в каталог продолжается установкой только в исходном проекте и профиле. */
export async function prepareProjectCatalogInstall({ inProject, canManage, current, add, refresh }: IPreparation): Promise<boolean> {
    if (!current()) { return false; }
    if (inProject) { return true; }
    if (!canManage) { throw new Error('Сначала администратор должен добавить инструмент в каталог проекта.'); }
    await add();
    if (!current()) { return false; }
    await refresh();
    return current();
}
