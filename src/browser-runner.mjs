// Host-owned browser capability. Never uses the user's Chrome profile.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export function browserRequired(cwd,role){
 if(!['developer','qa'].includes(role))return false;
 try{const pkg=JSON.parse(fs.readFileSync(path.join(cwd,'package.json'),'utf8'));return Object.keys({...pkg.dependencies,...pkg.devDependencies}).some(name=>/playwright|puppeteer|lighthouse|chrome-launcher/.test(name));}catch{return false;}
}
export function browserExecutable(override){
 if(override&&!path.isAbsolute(override))return undefined;
 const candidates=override?[override]:['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/Applications/Chromium.app/Contents/MacOS/Chromium',...String(process.env.PATH||'').split(path.delimiter).flatMap(dir=>['google-chrome','chromium','chromium-browser'].map(name=>path.join(dir,name)))];
 return candidates.find(file=>{try{fs.accessSync(file,fs.constants.X_OK);return fs.statSync(file).isFile();}catch{return false;}});
}
export function createBrowserRunner(executable,{timeoutMs=15000}={}){
 let child,profile,server,exited=false,stopped=false,closing,stderr='';
 const close=()=>closing??=(async()=>{
  stopped=true;
  if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));server=undefined;}
  if(child?.pid&&!exited){child.kill('SIGTERM');const deadline=Date.now()+1500;while(!exited&&Date.now()<deadline)await delay(25);if(!exited){child.kill('SIGKILL');await new Promise(resolve=>child.once('close',resolve));}}
  if(profile){fs.rmSync(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100});profile=undefined;}
 })();
 const start=async()=>{
  if(stopped)throw new Error('Browser preparation cancelled');
  if(!executable)throw new Error('Chrome/Chromium was not found. Install it on the Factory host or configure FACTORY_BROWSER_EXECUTABLE.');
  profile=fs.mkdtempSync(path.join(os.tmpdir(),'factory-browser-'));
  child=spawn(executable,['--headless=new','--no-first-run','--no-default-browser-check','--disable-background-networking','--remote-debugging-address=127.0.0.1','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{stdio:['ignore','ignore','pipe']});
  child.stderr.on('data',chunk=>{stderr=(stderr+chunk.toString()).slice(-4000)});
  child.on('error',error=>{stderr=error.message;exited=true});child.on('close',()=>{exited=true});
  const deadline=Date.now()+timeoutMs;
  const check=()=>{if(stopped)throw new Error('Browser preparation cancelled');if(exited)throw new Error(`Chrome exited before readiness: ${stderr}`);if(Date.now()>deadline)throw new Error(`Chrome readiness timed out: ${stderr}`)};
  let port;
  while(!port){check();try{port=Number(fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0]);}catch{}if(!port)await delay(50);}
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid Chrome debugging port');
  const endpoint=`http://127.0.0.1:${port}`;
  const request=async(url,options={})=>{check();const response=await fetch(url,{...options,signal:AbortSignal.timeout(Math.max(1,deadline-Date.now()))});if(!response.ok)throw new Error(`Chrome probe HTTP ${response.status}`);return response};
  const version=await (await request(endpoint+'/json/version')).json();
  if(!version.webSocketDebuggerUrl)throw new Error('Chrome debugging endpoint unavailable');
  const token=randomUUID();let loaded=false;
  server=http.createServer((req,res)=>{if(req.url===`/${token}`)loaded=true;res.setHeader('Content-Type','text/html');res.end('<title>Factory browser ready</title><h1>Ready</h1>')});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
  const url=`http://127.0.0.1:${server.address().port}/${token}`;
  const tab=await (await request(endpoint+'/json/new?'+encodeURIComponent(url),{method:'PUT'})).json();
  while(!loaded){check();await delay(25)}
  await request(endpoint+'/json/close/'+encodeURIComponent(tab.id));
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));server=undefined;
  return {endpoint,port,browser:version.Browser,node:process.version,checkedAt:new Date().toISOString(),checks:['browser-start','debugging-connection','loopback-page']};
 };
 return {start,close};
}
function previewScript(cwd){
 try{
  const scripts=JSON.parse(fs.readFileSync(path.join(cwd,'package.json'),'utf8')).scripts??{};
  return ['local:serve','preview','dev','serve'].find(name=>typeof scripts[name]==='string');
 }catch{return undefined;}
}
export function browserInstructions(cwd){
 const script=previewScript(cwd);
 const preview=script
  ? `For this project, use \`npm run ${script}\` as the transient preview server when one is needed.`
  : 'Use the project\'s ordinary non-persistent development or preview command when one is needed.';
 return `\n\nFactory browser runner:\nRead process.env.FACTORY_BROWSER_REPORT for the host supervisor readiness evidence. If FACTORY_BROWSER_STATUS is unavailable, the report explains why; do not assume the browser is ready.\nUse process.env.FACTORY_BROWSER_CDP_URL with playwright.chromium.connectOverCDP() instead of chromium.launch(). For Lighthouse use Number(process.env.FACTORY_BROWSER_DEBUG_PORT) as its port; do not call chrome-launcher. Adapt browser test scripts to support these environment variables while retaining standalone local launch as fallback. ${preview} Start it as an ephemeral child process of this execution, wait for its loopback port, and connect to it over 127.0.0.1. It only needs to live during this execution: the Factory worker supervisor owns its process group and cleans it up afterwards. Never register a system service or use launchctl, systemctl, service, pm2, or a persistent local-start script to run a preview. This browser uses a fresh temporary profile, with no user cookies or credentials. Do not navigate to file:// URLs or read host files through the browser. The supervisor owns browser lifecycle; do not kill the browser or invoke Browser.close via CDP. Close your own contexts. These probes establish infrastructure readiness only; run all required project checks and record their evidence. If the connection fails, report environment-blocked with the actual error.\n`;}
