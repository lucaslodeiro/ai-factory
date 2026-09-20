import {CONTROLLER_LEASE_MS} from "./controller-lease.js";

export type ControllerMode="active"|"standby"|"uncertain"|"fenced";

export function controllerModeAfterVerificationFailure(mode:ControllerMode,lastVerifiedAtMs:number,nowMs:number):ControllerMode{
 return mode==="active"&&nowMs-lastVerifiedAtMs>=CONTROLLER_LEASE_MS?"uncertain":mode;
}

export function controllerMayMutate(mode:ControllerMode){return mode==="active";}

export function assertLocalController(mode:ControllerMode,cachedGeneration:number|null,acquiredGeneration:number){
 if(!controllerMayMutate(mode)||cachedGeneration!==acquiredGeneration)throw new Error(`Repository controller is ${mode}`);
}
