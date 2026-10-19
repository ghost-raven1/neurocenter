export function setMaintenanceMetrics(status:{external:unknown;externalAgeSeconds:number|null;rpoExceeded:boolean;nextRunAt:string|null;runs:{state:string}[]}):void;
export function renderMaintenanceMetrics():string;
