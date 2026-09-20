import {CONTROLLER_LEASE_MS} from "./controller-lease.js";

export type ControllerMode="active"|"standby"|"uncertain"|"fenced";

export function controllerModeAfterVerificationFailure(mode:ControllerMode,lastVerifiedAtMs:number,nowMs:number):ControllerMode{
 return mode==="active"&&nowMs-lastVerifiedAtMs>=CONTROLLER_LEASE_MS?"uncertain":mode;
}

export function controllerMayMutate(mode:ControllerMode){return mode==="active";}
