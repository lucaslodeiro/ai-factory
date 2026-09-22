export function browserRequired(cwd:string,role:string):boolean;
export function browserInstructions(cwd:string,runtimeUrl?:string):string;
export function browserExecutable(override?:string):string|undefined;
export function createBrowserRunner(executable?:string,options?:{timeoutMs?:number}):{start():Promise<{endpoint:string;port:number;browser:string;node:string;checkedAt:string;checks:string[]}>;close():Promise<void>};
