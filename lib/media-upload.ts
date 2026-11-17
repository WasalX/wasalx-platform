export async function mediaUploadSha256(file:Blob){
  const digest=new Uint8Array(await crypto.subtle.digest("SHA-256",await file.arrayBuffer()));
  return Array.from(digest,byte=>byte.toString(16).padStart(2,"0")).join("");
}

export function mediaAssetCatalogPath(selectedIds:string[],uploadedId?:string,replacedId?:string){
  const ids=[...new Set([...selectedIds.filter(id=>id&&id!==replacedId),...(uploadedId?[uploadedId]:[])])];
  const query=new URLSearchParams(ids.map(id=>["id",id])).toString();
  return `/api/bot-flows/media-assets${query?`?${query}`:""}`;
}
