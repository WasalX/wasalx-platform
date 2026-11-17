import { readFile } from "node:fs/promises";
import type { ProvisionerConfig } from "./config.js";
import { ProvisionerError, type TenantWorkspace } from "./types.js";

const MAX_KUBERNETES_RESPONSE_BYTES = 512_000;

export interface WorkspaceResourceClient {
  get(name: string): Promise<TenantWorkspace | null>;
  apply(resource: TenantWorkspace): Promise<TenantWorkspace>;
  ready(): Promise<boolean>;
}

export class KubernetesWorkspaceClient implements WorkspaceResourceClient {
  private readonly collectionPath: string;

  constructor(private readonly config: ProvisionerConfig) {
    this.collectionPath = `/apis/platform.wasalx.io/v1alpha1/namespaces/${encodeURIComponent(
      config.workspaceNamespace,
    )}/tenantworkspaces`;
  }

  async get(name: string) {
    const response = await this.request(`${this.collectionPath}/${encodeURIComponent(name)}`, {
      method: "GET",
    }, true);
    return response === null ? null : parseWorkspace(response);
  }

  async apply(resource: TenantWorkspace) {
    const path = `${this.collectionPath}/${encodeURIComponent(resource.metadata.name)}?fieldManager=wasalx-tenant-provisioner`;
    const response = await this.request(path, {
      method: "PATCH",
      headers: { "content-type": "application/apply-patch+yaml" },
      body: JSON.stringify(resource),
    });
    return parseWorkspace(response);
  }

  async ready() {
    try {
      await this.request(`${this.collectionPath}?limit=1`, { method: "GET" });
      return true;
    } catch {
      return false;
    }
  }

  private async request(
    path: string,
    init: RequestInit,
    allowNotFound = false,
  ): Promise<unknown | null> {
    const token = (await readFile(this.config.kubernetesTokenFile, "utf8")).trim();
    if (token.length < 16 || token.length > 16_384 || hasControl(token)) {
      throw unavailable("The Kubernetes service-account credential is unavailable.");
    }
    let response: Response;
    try {
      response = await fetch(new URL(path, this.config.kubernetesApiUrl), {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          ...init.headers,
        },
        redirect: "error",
        signal: AbortSignal.timeout(this.config.kubernetesRequestTimeoutMs),
      });
    } catch {
      throw unavailable("The Kubernetes API is temporarily unavailable.");
    }
    if (allowNotFound && response.status === 404) return null;
    if (!response.ok) {
      if (response.status === 409) {
        throw new ProvisionerError(
          409,
          "WORKSPACE_CONFLICT",
          "The tenant workspace changed concurrently. Retry with a fresh fence.",
        );
      }
      if (response.status === 401 || response.status === 403) {
        throw unavailable("The tenant provisioner is not authorized to reconcile workspaces.");
      }
      if (response.status === 404 || response.status === 422) {
        throw unavailable("The TenantWorkspace Kubernetes contract is unavailable or incompatible.");
      }
      throw unavailable("The Kubernetes API rejected the tenant workspace operation.");
    }
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_KUBERNETES_RESPONSE_BYTES) {
      throw unavailable("The Kubernetes API returned an oversized response.");
    }
    const bytes = await boundedBytes(response);
    if (bytes.byteLength === 0) return {};
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    } catch {
      throw unavailable("The Kubernetes API returned an invalid response.");
    }
  }
}

async function boundedBytes(response: Response) {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_KUBERNETES_RESPONSE_BYTES) {
        await reader.cancel();
        throw unavailable("The Kubernetes API returned an oversized response.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function parseWorkspace(value: unknown): TenantWorkspace {
  const root = record(value);
  if (!root) throw unavailable("The Kubernetes API returned an invalid workspace.");
  const metadata = record(root.metadata);
  const spec = record(root.spec);
  if (
    root.apiVersion !== "platform.wasalx.io/v1alpha1" ||
    root.kind !== "TenantWorkspace" ||
    typeof metadata?.name !== "string" ||
    !spec
  ) {
    throw unavailable("The Kubernetes API returned an invalid workspace.");
  }
  return value as TenantWorkspace;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hasControl(value: string) {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  });
}

function unavailable(message: string) {
  return new ProvisionerError(503, "KUBERNETES_UNAVAILABLE", message, true);
}
