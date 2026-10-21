import { ArchiveAssetButton } from '../../features/AssetManagement/ArchiveAssetButton';
import type { IStoreApp } from './AppCard';

/** A project pin alone never grants an action against an absent common catalog head. */
export function storeArchiveTarget(app: IStoreApp, common: readonly IStoreApp[], isMain: boolean): IStoreApp | undefined {
    if (!isMain || app.kind === 'skill' && !/^common\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(app.id)) return undefined;
    return common.find(item => item.id === app.id && item.kind === app.kind);
}

/** Reuses the server's impact, project-removal choice and idempotent archive receipt. */
export function StoreArchiveAction({ app, common, isMain, disabled, block = true, onArchived }: {
    app: IStoreApp; common: readonly IStoreApp[]; isMain: boolean; disabled?: boolean; block?: boolean; onArchived(): void;
}): JSX.Element | null {
    const target = storeArchiveTarget(app, common, isMain);
    return target ? <ArchiveAssetButton kind={target.kind} id={target.id} disabled={disabled} onArchived={onArchived}
        buttonProps={{ size: 'small', block, 'aria-label': `Удалить из общего каталога: ${target.name}` }}>Удалить из общего каталога</ArchiveAssetButton> : null;
}
