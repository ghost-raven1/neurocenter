export interface IFileDropZoneProps {
    label:string;
    title:string;
    hint?:string;
    buttonText:string;
    accept?:string;
    multiple?:boolean;
    disabled?:boolean;
    busy?:boolean;
    onFiles:(files:File[])=>void;
    onReject:(message:string)=>void;
}
