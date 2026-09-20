// Managed services must not retry permanent setup failures in a launchd loop.
export class StartupError extends Error {}
export function startupExitCode(error:unknown,managed=process.env.FACTORY_MANAGED_SERVICE==="1"){
 return managed&&error instanceof StartupError?0:1;
}
