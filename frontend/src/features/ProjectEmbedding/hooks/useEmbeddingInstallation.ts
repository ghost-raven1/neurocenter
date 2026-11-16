import { useState } from 'react';
import type { IBridgeInstallation } from '../../McpBridge/api';

export const embeddingInstallationKey = (item: IBridgeInstallation): string =>
    JSON.stringify([item.assetKind, item.assetId, item.version, item.manifest]);
interface ISelection {
    scope: string;
    item?: IBridgeInstallation;
}

/** Единственный пакет закрепляется в текущей папке; персист проекта имеет приоритет над соседними установками. */
export function useEmbeddingInstallation(
    scope: string,
    choices: IBridgeInstallation[],
    ready: boolean,
    persistedKey?: string,
) {
    const sole = ready && choices.length === 1 ? choices[0] : undefined;
    const seed = (): IBridgeInstallation | undefined =>
        (persistedKey && choices.find((item) => embeddingInstallationKey(item) === persistedKey)) || sole;
    const [saved, setSaved] = useState<ISelection>(() => ({ scope, item: seed() }));
    let selection = saved.scope === scope ? saved : { scope, item: seed() };
    if (!selection.item && sole) selection = { scope, item: sole };
    // Корректировка собственного state до дочернего render сохраняет его request key при изменении списка.
    if (selection !== saved) setSaved(selection);
    const selectedKey = selection.item && embeddingInstallationKey(selection.item);
    const available = choices.find((item) => embeddingInstallationKey(item) === selectedKey);
    return {
        item: available || selection.item,
        eligible: !!available,
        choose: (key: string) => {
            const item = choices.find((value) => embeddingInstallationKey(value) === key);
            if (ready && item) setSaved({ scope, item });
        },
    };
}
