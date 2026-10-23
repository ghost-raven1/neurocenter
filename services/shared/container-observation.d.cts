export interface ContainerObservation {schema:1;project:string;checkedAt:string;available:boolean;items?:Array<{service:string;state:string;health:string}>;reason?:string;}
export function containerObservation(value:unknown):ContainerObservation;
export function validComposeProject(value:unknown):value is string;
