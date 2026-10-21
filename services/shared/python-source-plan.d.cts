export interface PythonSourcePlan {
 schemaVersion:1;
 projectDirectory:string;
 entry:{type:'script'|'module'|'callable';value:string};
 searchPaths:string[];
 requirements:string[];
 requiresPython?:string;
 distribution?:{name:string;version:string};
}
export function validatePythonPlan(value:unknown):PythonSourcePlan;
export function validatePythonRequirements(value:unknown):string[];
