export interface ICasValues {
    expectedHeadId: string;
    expectedHeadRevision: number;
}

export interface IConfirmCasModalProps {
    open: boolean;
    title: string;
    confirmText?: string;
    loading?: boolean;
    defaultExpectedId?: string;
    defaultExpectedRevision?: number;
    onConfirm: (values: ICasValues) => void | Promise<void>;
    onCancel: () => void;
}