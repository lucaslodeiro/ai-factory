import fs from 'node:fs';
import path from 'node:path';
export interface VerificationPolicy {evidenceDirectories:string[];testFiles:string[];}
export const verificationPolicyFile='.factory/verification.json';
const safePath=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&!path.posix.isAbsolute(value)&&!value.includes('\\')&&!/[\*?\[\]{}\x00-\x1f]/.test(value)&&!value.split('/').some(part=>!part||part==='.'||part==='..'||part.startsWith('.'));
export function verificationPolicy(cwd:string):VerificationPolicy{
 const file=path.join(cwd,verificationPolicyFile);
 if(!fs.existsSync(file))return{evidenceDirectories:['evidence'],testFiles:[]};
 if(fs.lstatSync(path.dirname(file)).isSymbolicLink()||!fs.lstatSync(file).isFile()||fs.lstatSync(file).isSymbolicLink())throw new Error('Verification policy must be a regular repository file');
 const value=JSON.parse(fs.readFileSync(file,'utf8'));
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['evidenceDirectories','testFiles'].includes(key)))throw new Error('Invalid verification policy');
 const result={evidenceDirectories:value.evidenceDirectories??['evidence'],testFiles:value.testFiles??[]};
 for(const paths of [result.evidenceDirectories,result.testFiles])if(!Array.isArray(paths)||!paths.every(safePath))throw new Error('Verification paths must be explicit relative paths without hidden or parent segments');
 return result;
}
export function secretPath(file:string){return /(^|\/)(\.env($|\.)|auth\.json$|credentials)/i.test(file);}
export function protectedVerificationPath(file:string){return secretPath(file)||file===verificationPolicyFile||/(^|\/)(package(?:-lock)?\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|deno\.jsonc?|deno\.lock|pyproject\.toml|poetry\.lock|requirements[^/]*\.txt|Cargo\.(toml|lock)|go\.(mod|sum)|Gemfile(?:\.lock)?|composer\.(json|lock))$/i.test(file)||file.split('/').some(part=>part.startsWith('.'));}
const transientBrowserEvidence=(file:string,policy:VerificationPolicy)=>policy.evidenceDirectories.some(dir=>file===`${dir}/browser/.last-run.json`);
export function verificationArtifactAllowed(file:string,policy:VerificationPolicy){return (transientBrowserEvidence(file,policy)||!protectedVerificationPath(file))&&policy.evidenceDirectories.some(dir=>file.startsWith(dir+'/'))&&/\.(json|md|txt|csv|png|jpe?g|webp)$/i.test(file);}
export function verificationPathAllowed(file:string,policy:VerificationPolicy){
 if(policy.evidenceDirectories.some(dir=>file.startsWith(dir+'/')))return verificationArtifactAllowed(file,policy);
 if(protectedVerificationPath(file))return false;
 return policy.testFiles.includes(file)||/(^|\/)(__tests__|tests?|specs?)\/|\.(test|spec)\.[^/]+$/.test(file);
}
