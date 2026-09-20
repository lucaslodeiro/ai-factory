import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

test("dashboard explains active and standby repository control and removes standby workflow actions",()=>{const root=path.resolve(new URL("..",import.meta.url).pathname),html=fs.readFileSync(path.join(root,"dashboard/index.html"),"utf8"),app=fs.readFileSync(path.join(root,"dashboard/app.js"),"utf8");assert.match(html,/Controller details/);assert.doesNotMatch(html,/REPOSITORY CONTROLLER/);assert.doesNotMatch(html,/id="remote-issues"/);assert.match(html,/Release control/);assert.match(html,/Force takeover/);assert.match(app,/This factory is in control/);assert.match(app,/This installation does not process issues or modify GitHub/);assert.match(app,/Not tracked here/);assert.match(app,/data-project-controller/);assert.ok(app.includes("const actions=standby?'':(item.actions||[])"));assert.match(app,/const standby=data.controller\?\.state!=='active'/);});

test('controller mutations require dialog confirmation while refresh remains read-only',async()=>{
 const vm=await import('node:vm'),source=fs.readFileSync(new URL('../dashboard/app.js',import.meta.url),'utf8'),elements=new Map<string,any>(),requests:any[]=[];
 const get=(selector:string)=>{if(!elements.has(selector))elements.set(selector,{value:'',open:false,showModal(){this.open=true},addEventListener(type:string,fn:any){this[type]=fn}});return elements.get(selector)};
 const context=vm.createContext({$:get,window:{},controllerBusy:false,pendingControllerAction:null,lastSnapshot:{repository:'owner/demo'},executeControllerAction:(body:any)=>requests.push(body)});
 for(const line of source.split('\n').filter(line=>line.startsWith('function controllerAction(')||line.startsWith("$('#controller-confirm-form').addEventListener")))vm.runInContext(line,context);
 vm.runInContext("controllerAction('release')",context);assert.equal(requests.length,0);assert.equal(get('#controller-dialog').open,true);get('#controller-confirm-form').submit({preventDefault(){}});assert.equal(requests[0].action,'release');
 vm.runInContext("controllerAction('force')",context);assert.equal(requests.length,1);assert.equal(get('#controller-confirmation').required,true);get('#controller-confirmation').value='owner/demo';get('#controller-confirm-form').submit({preventDefault(){}});assert.equal(requests[1].force,true);assert.equal(requests[1].confirmation,'owner/demo');
 vm.runInContext("controllerAction('refresh')",context);assert.equal(requests[2].action,'refresh');
});
