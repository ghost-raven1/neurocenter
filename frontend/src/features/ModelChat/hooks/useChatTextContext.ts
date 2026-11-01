import { useState } from 'react';
import { TEXT_KNOWLEDGE_CEILINGS, normalizeTextContext, type ITextContext } from '@neurocenter/project-text-knowledge';
import { useAuthRequestOwner } from '../../UserBlock/hooks/useAuthRequestOwner';
import { useFeatureAvailability } from '../../FeatureFlags/FeatureAvailability';

/** Selection belongs to one draft; immutable request copies live in the existing submission journal. */
export function useChatTextContext(modelId: string, projectId?: string, conversationId?: string) {
    const { scope, captureOwner } = useAuthRequestOwner();
    const availability = useFeatureAvailability('project_text_knowledge');
    const identity = JSON.stringify([scope, modelId, projectId, conversationId]);
    const [saved, setSaved] = useState<{ identity: string; selection: ITextContext }>();
    const selection = saved?.identity === identity ? saved.selection : undefined;
    const clear = () => setSaved(undefined);
    const select = (value: ITextContext) => {
        if (projectId && captureOwner()() && availability.enabled)
            setSaved({ identity, selection: normalizeTextContext(value, TEXT_KNOWLEDGE_CEILINGS) });
    };
    const restore = (value?: ITextContext) => {
        if (!captureOwner()()) return;
        setSaved(value ? { identity, selection: normalizeTextContext(value, TEXT_KNOWLEDGE_CEILINGS) } : undefined);
    };
    return { selection, select, clear, restore, availability, identity };
}
