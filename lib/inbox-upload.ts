import { readBoundedBody } from "./bounded-json";
import { isControlPlaneBackend, sitesPrivateDemoError } from "./backend";
import { portalInboxUploadRequest } from "./control-plane-data";
import { authenticatePortalBinaryUploadRequest, authErrorResponse } from "./request-auth";
import { MediaUploadAdmission, normalizeMediaMime, safeMediaFilename } from "../packages/core/src/media";

const admission = new MediaUploadAdmission(2, 1);
const noStore = { "cache-control": "private, no-store" };
const invalid = () => Response.json({ error: "Choose one supported file up to 50 MB" }, { status: 400, headers: noStore });

export async function inboxUpload(request: Request, groupAlias = false) {
  let release: (() => void) | null = null;
  try {
    const principal = await authenticatePortalBinaryUploadRequest(request, "ticket:write", ["multipart/form-data"]);
    if (!isControlPlaneBackend()) throw sitesPrivateDemoError("Conversation files");
    release = admission.tryAcquire(principal.tenantId);
    if (!release) return Response.json({ error: "Another upload is in progress" }, { status: 429, headers: { ...noStore, "retry-after": "2" } });
    const type = request.headers.get("content-type") ?? "";
    if (type.length > 256 || !/;\s*boundary=(?:"[^"\r\n]{1,200}"|[^;\s\r\n]{1,200})\s*$/iu.test(type)) return invalid();
    const bytes = await readBoundedBody(request, 50_016_384, 30_000);
    let form: FormData;
    try { form = await new Response(Uint8Array.from(bytes).buffer, { headers: { "content-type": type } }).formData(); }
    catch { return invalid(); }
    const keys = [...form.keys()];
    const required = groupAlias ? ["group_id", "upload_cache_id", "files"] : ["operation", "input", "file"];
    if (keys.length !== required.length || !required.every(key => keys.includes(key))) return invalid();
    const file = form.get(groupAlias ? "files" : "file");
    if (!(file instanceof File) || !file.size || file.size > 50_000_000) return invalid();
    let operation: string, input: unknown;
    if (groupAlias) {
      operation = "GROUP_UPLOAD";
      input = { group_id: form.get("group_id"), upload_cache_id: form.get("upload_cache_id") };
    } else {
      const value = form.get("operation"), encoded = form.get("input");
      if (typeof value !== "string" || typeof encoded !== "string" || encoded.length > 1_024) return invalid();
      operation = value;
      try { input = JSON.parse(encoded); } catch { return invalid(); }
    }
    const result = await portalInboxUploadRequest(principal, { operation, input }, file,
      { filename: safeMediaFilename(file.name), mime_type: normalizeMediaMime(file.type) || "application/octet-stream" });
    return Response.json(result, { headers: noStore });
  } catch (error) { return authErrorResponse(error); }
  finally { release?.(); }
}
