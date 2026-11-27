type PlatformOperator = { csrfToken: string; recoveryScope?: string };
type PlatformRequestOptions = {
  method?: string;
  body?: unknown;
  idempotencyKey?: string;
  signal?: AbortSignal;
};

export function platformRequest(operator: PlatformOperator, path: string, options: PlatformRequestOptions & { response: "empty" }): Promise<void>;
export function platformRequest<T>(operator: PlatformOperator, path: string, options?: PlatformRequestOptions & { response?: "json" }): Promise<T>;
export async function platformRequest<T>(operator: PlatformOperator, path: string, options: PlatformRequestOptions & { response?: "json" | "empty" } = {}): Promise<T | void> {
  const response=await fetch(`/api/platform-console/${path}`,{method:options.method??"GET",headers:{accept:"application/json",
    ...(path.startsWith("operations/tenants/")&&path.includes("/meta/account-transitions")&&operator.recoveryScope?{"x-wasalx-platform-recovery-scope":operator.recoveryScope}:{}),
    ...(options.body===undefined?{}:{"content-type":"application/json","x-wasalx-platform-csrf":operator.csrfToken}),
    ...(options.idempotencyKey?{"idempotency-key":options.idempotencyKey}:{})},
    body:options.body===undefined?undefined:JSON.stringify(options.body),cache:"no-store",signal:options.signal});
  assertPlatformResponse(response);
  if (options.response === "empty") {
    if (response.status !== 204) throw new Error("platform_invalid_response");
    return;
  }
  return response.json() as Promise<T>;
}

export async function platformBinaryRequest(operator:{csrfToken:string},path:string,options:{method?:"PUT";body?:ArrayBuffer;mimeType?:string;signal?:AbortSignal}={}){
  if(!/^meta-costs\/tenants\/[0-9a-f-]{36}\/statements\/[0-9a-f-]{36}\/source$/iu.test(path))throw new Error("platform_request_failed");
  const response=await fetch(`/api/platform-console/${path}`,{method:options.method??"GET",headers:{
    ...(options.body===undefined?{}:{"content-type":options.mimeType??"application/octet-stream","x-wasalx-platform-csrf":operator.csrfToken})},
    body:options.body,cache:"no-store",redirect:"error",signal:options.signal});
  assertPlatformResponse(response);
  return response;
}

function assertPlatformResponse(response:Response){
  if(response.status===401){const returnTo=`${window.location.pathname}${window.location.search}${window.location.hash}`;window.location.assign(`/platform/auth/login?return_to=${encodeURIComponent(returnTo)}`);}
  if(!response.ok)throw Object.assign(new Error("platform_request_failed"),{status:response.status});
}
