import type {GitHubPort,Repository} from "./adapters/github.js";
import type {Store} from "./storage.js";

export type StoredRepositoryIdentity={id:number;nodeId:string;fullName:string};

export function repositoryIdentityError(stored:StoredRepositoryIdentity,current:Repository){return `Data directory belongs to repository ${stored.fullName} (id ${stored.id}); the configured repository has a different id. Use an empty FACTORY_DATA_DIR.`;}

export function verifyRepositoryIdentity(store:Store,github:Pick<GitHubPort,"repository">,bind=true){
 const current=github.repository(),stored=store.metadata<StoredRepositoryIdentity>("repository_identity");
 if(stored&&stored.id!==current.id)throw new Error(repositoryIdentityError(stored,current));
 if(!stored&&bind)store.setMetadata("repository_identity",{id:current.id,nodeId:current.nodeId,fullName:current.fullName} satisfies StoredRepositoryIdentity);
 return current;
}
