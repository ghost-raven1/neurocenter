import type { useChatTextContext } from '../hooks/useChatTextContext';
export interface IChatTextContextProps {
    projectId?: string;
    value: ReturnType<typeof useChatTextContext>;
    disabled: boolean;
    conflicting: boolean;
    onUseTextContext: () => void;
    open: boolean;
    onOpenChange: (open: boolean) => void;
}
