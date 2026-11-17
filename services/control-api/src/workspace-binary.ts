import { BadRequestException, PayloadTooLargeException, RequestTimeoutException } from "@nestjs/common";
import type { FastifyAdapter } from "@nestjs/platform-fastify";
import { Readable } from "node:stream";

export const WORKSPACE_UPLOAD_TYPE = "application/vnd.wasalx.workspace-upload";
export const WORKSPACE_UPLOAD_MAX_BYTES = 50_000_000;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu;
const POSITIVE = /^[1-9][0-9]{0,15}$/u;
export type WorkspaceUpload = { operation: "GROUP_UPLOAD" | "TICKET_UPLOAD";
  input: { upload_cache_id: string; group_id?: string; ticket_id?: string; create_group_id?: string };
  file: { filename: string; mime_type: string; byte_size: number; sha256: string } };

export function validateWorkspaceUpload(value: unknown): WorkspaceUpload {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BadRequestException("Invalid upload");
  const body = value as WorkspaceUpload;
  const keys = (v: object, expected: string[]) => Object.keys(v).sort().join(",") === expected.sort().join(",");
  if (!keys(body, ["operation", "input", "file"]) || !body.input || Array.isArray(body.input) || typeof body.input !== "object" ||
      !body.file || Array.isArray(body.file) || typeof body.file !== "object") throw new BadRequestException("Invalid upload");
  const target = body.operation === "GROUP_UPLOAD" ? "group_id" : body.operation === "TICKET_UPLOAD" ?
    (Object.hasOwn(body.input, "ticket_id") ? "ticket_id" : "create_group_id") : undefined;
  if (!target || !keys(body.input, ["upload_cache_id", target]) || typeof body.input.upload_cache_id !== "string" ||
      !UUID.test(body.input.upload_cache_id) || typeof body.input[target] !== "string" ||
      !(target === "group_id" ? UUID : POSITIVE).test(body.input[target]!)) throw new BadRequestException("Invalid upload target");
  const file = body.file;
  if (!keys(file, ["filename", "mime_type", "byte_size", "sha256"]) || typeof file.filename !== "string" ||
      !file.filename || [...file.filename].length > 120 || file.filename !== file.filename.normalize("NFC") ||
      file.filename !== file.filename.trim() || /[\p{Cc}\p{Cf}/\\]/u.test(file.filename) ||
      typeof file.mime_type !== "string" || !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u.test(file.mime_type) ||
      file.mime_type.length > 120 || !Number.isSafeInteger(file.byte_size) || file.byte_size < 1 || file.byte_size > WORKSPACE_UPLOAD_MAX_BYTES ||
      typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(file.sha256)) throw new BadRequestException("Invalid upload file");
  return body;
}

// Keep the payload as a stream until Nest has authenticated the caller and admitted its tenant.
export function registerWorkspaceBinary(adapter: FastifyAdapter) {
  adapter.getInstance().addContentTypeParser(WORKSPACE_UPLOAD_TYPE, (request, payload, done) => {
    if (request.method !== "POST" || request.url !== "/v1/inbox/upload") return done(Object.assign(new Error("Unsupported upload"), { statusCode: 415 }), undefined);
    done(null, payload);
  });
}

export async function readWorkspaceUpload(body: unknown, expected: number): Promise<Buffer> {
  if (!(body instanceof Readable)) throw new BadRequestException("Invalid upload body");
  const chunks: Buffer[] = []; let size = 0;
  const timeout = setTimeout(() => body.destroy(new RequestTimeoutException("Upload timed out")), 30_000);
  try {
    for await (const value of body) {
      if (!Buffer.isBuffer(value)) throw new BadRequestException("Invalid upload body");
      size += value.length;
      if (size > expected || size > WORKSPACE_UPLOAD_MAX_BYTES) throw new PayloadTooLargeException("Upload is too large");
      chunks.push(value);
    }
    if (size !== expected) throw new BadRequestException("Upload was incomplete");
    return Buffer.concat(chunks, size);
  } catch (error) { body.destroy(); throw error; }
  finally { clearTimeout(timeout); }
}
