import { MEDIA_LIMITS, normalizeMediaMime } from "./media.js";

export type OutboundMediaProvider = "WAHA" | "META";
export type OutboundMediaKind = "image" | "audio" | "video" | "document";

export type OutboundMediaRule = {
  kind: OutboundMediaKind;
  maximumBytes: number;
};

export type GroupWorkspaceMediaCapabilities = {
  accepted: Array<{ mime_type: string; maximum_bytes: number }>;
  voice_recording: boolean;
  maximum_files: number;
  maximum_total_bytes: number;
};

export const GROUP_WORKSPACE_MAX_ATTACHMENTS = 10;
export const GROUP_WORKSPACE_MAX_TOTAL_BYTES = 250_000_000;

const META_OUTBOUND_LIMITS: Readonly<Record<string, OutboundMediaRule>> = Object.freeze({
  "image/jpeg": { kind: "image", maximumBytes: 5 * 1024 * 1024 },
  "image/png": { kind: "image", maximumBytes: 5 * 1024 * 1024 },
  "audio/aac": { kind: "audio", maximumBytes: 16 * 1024 * 1024 },
  "audio/mp4": { kind: "audio", maximumBytes: 16 * 1024 * 1024 },
  "audio/mpeg": { kind: "audio", maximumBytes: 16 * 1024 * 1024 },
  "audio/amr": { kind: "audio", maximumBytes: 16 * 1024 * 1024 },
  "audio/ogg": { kind: "audio", maximumBytes: 16 * 1024 * 1024 },
  "video/mp4": { kind: "video", maximumBytes: 16 * 1024 * 1024 },
  "video/3gpp": { kind: "video", maximumBytes: 16 * 1024 * 1024 },
  "application/pdf": { kind: "document", maximumBytes: 100 * 1024 * 1024 },
  "application/msword": { kind: "document", maximumBytes: 100 * 1024 * 1024 },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": { kind: "document", maximumBytes: 100 * 1024 * 1024 },
  "application/vnd.ms-excel": { kind: "document", maximumBytes: 100 * 1024 * 1024 },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": { kind: "document", maximumBytes: 100 * 1024 * 1024 },
  "application/vnd.ms-powerpoint": { kind: "document", maximumBytes: 100 * 1024 * 1024 },
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": { kind: "document", maximumBytes: 100 * 1024 * 1024 },
  "text/plain": { kind: "document", maximumBytes: 100 * 1024 * 1024 },
  "text/csv": { kind: "document", maximumBytes: 100 * 1024 * 1024 },
});

export function providerOutboundMediaRule(provider: OutboundMediaProvider, declaredMime: string): OutboundMediaRule | undefined {
  const mimeType = normalizeMediaMime(declaredMime);
  const productMaximum = MEDIA_LIMITS[mimeType];
  if (!productMaximum) return undefined;
  if (provider === "META") {
    const providerRule = META_OUTBOUND_LIMITS[mimeType];
    return providerRule ? { ...providerRule, maximumBytes: Math.min(productMaximum, providerRule.maximumBytes) } : undefined;
  }
  return provider === "WAHA" ? { kind: mediaKind(mimeType), maximumBytes: productMaximum } : undefined;
}

export function groupWorkspaceMediaCapabilities(provider: OutboundMediaProvider): GroupWorkspaceMediaCapabilities {
  const accepted = Object.keys(MEDIA_LIMITS).sort().flatMap((mimeType) => {
    const rule = providerOutboundMediaRule(provider, mimeType);
    return rule ? [{ mime_type: mimeType, maximum_bytes: rule.maximumBytes }] : [];
  });
  return {
    accepted,
    voice_recording: accepted.some((entry) => entry.mime_type === "audio/webm"),
    maximum_files: GROUP_WORKSPACE_MAX_ATTACHMENTS,
    maximum_total_bytes: GROUP_WORKSPACE_MAX_TOTAL_BYTES,
  };
}

function mediaKind(mimeType: string): OutboundMediaKind {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("video/")) return "video";
  return "document";
}
