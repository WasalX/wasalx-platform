export type MediaScanResult = { state: "CLEAN" | "INFECTED" | "ERROR"; engine: string; signature?: string };
export type MediaScanner = { scan(bytes: Uint8Array, mimeType: string): Promise<MediaScanResult> };
export type MediaStorage = {
  put(key: string, bytes: Uint8Array, metadata: Record<string, string>): Promise<void>;
  signedUrl(key: string, expiresSeconds: number): Promise<string>;
};
export type MediaRecord = {
  id: string;
  tenantId: string;
  sha256: string;
  objectKey: string;
  mimeType: string;
  byteSize: number;
  scanState: "CLEAN";
  expiresAt: string;
  createdAt: string;
};
export type MediaReservation = Omit<MediaRecord, "scanState"> & { scanState: "STAGING" | "CLEAN" };
export type MediaRepository = {
  findByHash(tenantId: string, sha256: string): Promise<MediaRecord | null>;
  reserve(record: MediaRecord): Promise<MediaReservation>;
  promote(record: MediaRecord): Promise<MediaRecord>;
};

export class MediaUploadAdmission {
  private active=0;
  private readonly activeByTenant=new Map<string,number>();
  private readonly maximum:number;
  private readonly maximumPerTenant:number;
  constructor(maximum=2,maximumPerTenant=maximum){
    if(!Number.isSafeInteger(maximum)||maximum<1||maximum>10||!Number.isSafeInteger(maximumPerTenant)||maximumPerTenant<1||maximumPerTenant>maximum)throw new Error("Media upload concurrency is invalid");
    this.maximum=maximum;this.maximumPerTenant=maximumPerTenant;
  }
  tryAcquire(tenantId="shared"){
    const tenantActive=this.activeByTenant.get(tenantId)??0;
    if(this.active>=this.maximum||tenantActive>=this.maximumPerTenant)return null;
    this.active+=1;this.activeByTenant.set(tenantId,tenantActive+1);let released=false;
    return()=>{if(!released){released=true;this.active-=1;const remaining=(this.activeByTenant.get(tenantId)??1)-1;if(remaining===0)this.activeByTenant.delete(tenantId);else this.activeByTenant.set(tenantId,remaining)}};
  }
}

export class MediaValidationError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly quarantine: boolean;

  constructor(message: string, code: string, options: { retryable?: boolean; quarantine?: boolean } = {}) {
    super(message);
    this.name = "MediaValidationError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.quarantine = options.quarantine ?? !this.retryable;
  }
}

export const MEDIA_LIMITS: Readonly<Record<string, number>> = Object.freeze({
  "image/png": 15_000_000,
  "image/jpeg": 15_000_000,
  "image/gif": 15_000_000,
  "image/webp": 15_000_000,
  "application/pdf": 25_000_000,
  "application/zip": 25_000_000,
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": 25_000_000,
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": 25_000_000,
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": 25_000_000,
  "audio/ogg": 25_000_000,
  "audio/mpeg": 25_000_000,
  "audio/mp4": 25_000_000,
  "audio/webm": 25_000_000,
  "video/mp4": 50_000_000,
});

export const WORKSPACE_INLINE_MEDIA_TYPES: ReadonlySet<string> = new Set([
  "image/jpeg", "image/png", "image/gif", "image/webp", "audio/ogg", "audio/mpeg", "audio/mp4", "audio/webm", "video/mp4",
]);

export function normalizeMediaMime(value: string) {
  return value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

export function maximumMediaBytes(declaredMime: string) {
  return MEDIA_LIMITS[normalizeMediaMime(declaredMime)];
}

export function safeMediaFilename(value: string) {
  const cleaned = Array.from(value.normalize("NFC"), (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127 || /[\p{Cc}\p{Cf}]/u.test(character) || character === "/" || character === "\\" ? "_" : character;
  }).join("");
  const base = cleaned.replace(/\.\.+/g, ".").trim();
  return (base || "attachment").slice(0, 120);
}

function zipEntryNames(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minimumEocd = 22;
  const earliestEocd = Math.max(0, bytes.length - minimumEocd - 65_535);
  let eocd = -1;
  for (let offset = bytes.length - minimumEocd; offset >= earliestEocd; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) return null;
  const entryCount = view.getUint16(eocd + 10, true);
  const directorySize = view.getUint32(eocd + 12, true);
  const directoryOffset = view.getUint32(eocd + 16, true);
  if (entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff || directoryOffset + directorySize > eocd) return null;
  const names = new Set<string>();
  let offset = directoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > eocd || view.getUint32(offset, true) !== 0x02014b50) return null;
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    if (next > eocd) return null;
    names.add(new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength)));
    offset = next;
  }
  return offset === directoryOffset + directorySize ? names : null;
}

function detectedMime(bytes: Uint8Array) {
  const text = (start: number, end: number) => new TextDecoder().decode(bytes.slice(start, end));
  if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (bytes.length >= 6 && (text(0, 6) === "GIF87a" || text(0, 6) === "GIF89a")) return "image/gif";
  if (bytes.length >= 12 && text(0, 4) === "RIFF" && text(8, 12) === "WEBP") return "image/webp";
  if (bytes.length >= 5 && text(0, 5) === "%PDF-") return "application/pdf";
  if (bytes.length >= 4 && text(0, 4) === "OggS") return "audio/ogg";
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return "audio/webm";
  if (bytes.length >= 3 && text(0, 3) === "ID3") return "audio/mpeg";
  if (bytes.length >= 2 && bytes[0] === 255 && (bytes[1]! & 0xe0) === 0xe0) return "audio/mpeg";
  if (bytes.length >= 12 && text(4, 8) === "ftyp") return "video/mp4";
  if (bytes.length >= 4 && bytes[0] === 80 && bytes[1] === 75 && [3, 5, 7].includes(bytes[2]!) && [4, 6, 8].includes(bytes[3]!)) {
    const entries = zipEntryNames(bytes);
    if (entries?.has("[Content_Types].xml") && entries.has("_rels/.rels")) {
      if (entries.has("word/document.xml")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
      if (entries.has("xl/workbook.xml")) return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
      if (entries.has("ppt/presentation.xml")) return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    }
    return "application/zip";
  }
  return "application/octet-stream";
}

function mimeMatches(declared: string, detected: string) {
  if (declared === detected) return true;
  // ISO Base Media files use the same container signature for audio and video;
  // their precise track type is verified later by Zammad/browser decoders.
  return declared === "audio/mp4" && detected === "video/mp4";
}

async function sha256(bytes: Uint8Array) {
  const hash = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class MediaService {
  private readonly scanner: MediaScanner;
  private readonly storage: MediaStorage;
  private readonly repository: MediaRepository;

  constructor(
    scanner: MediaScanner,
    storage: MediaStorage,
    repository: MediaRepository,
  ) {
    this.scanner = scanner;
    this.storage = storage;
    this.repository = repository;
  }

  async ingest(input: { tenantId: string; bytes: Uint8Array; declaredMime: string; filename: string; retentionDays: number; issueSignedUrl?: boolean }) {
    const declared = normalizeMediaMime(input.declaredMime);
    const maximum = MEDIA_LIMITS[declared];
    if (!maximum) throw new MediaValidationError("Unsupported media type", "UNSUPPORTED_MIME");
    if (!Number.isInteger(input.retentionDays) || input.retentionDays < 1 || input.retentionDays > 3_650) {
      throw new MediaValidationError("Media retention period is invalid", "INVALID_RETENTION");
    }
    if (input.bytes.length === 0 || input.bytes.length > maximum) {
      throw new MediaValidationError("Media size is outside the allowed range", "INVALID_SIZE");
    }
    const detected = detectedMime(input.bytes);
    if (!mimeMatches(declared, detected)) {
      throw new MediaValidationError("Declared media type does not match detected content", "MIME_MISMATCH");
    }

    const digest = await sha256(input.bytes);
    const expiresAt = new Date(Date.now() + input.retentionDays * 86_400_000).toISOString();
    let existing:MediaRecord|null;
    try{existing=await this.repository.findByHash(input.tenantId,digest)}catch{
      throw new MediaValidationError("Media repository is temporarily unavailable","MEDIA_REPOSITORY_UNAVAILABLE",{retryable:true,quarantine:false});
    }
    if (existing && new Date(existing.expiresAt).getTime() > Date.now()) {
      if (existing.mimeType !== declared)
        throw new MediaValidationError("Existing media content has a different type", "MEDIA_DEDUP_MIME_CONFLICT");
      let renewed:MediaReservation;
      try{renewed=await this.repository.reserve({...existing,expiresAt})}catch{
        throw new MediaValidationError("Media reservation is temporarily unavailable","MEDIA_RESERVATION_UNAVAILABLE",{retryable:true,quarantine:false});
      }
      if(renewed.scanState!=="CLEAN")throw new MediaValidationError("Existing media reservation is not ready", "MEDIA_RESERVATION_CONFLICT");
      const record={...renewed,scanState:"CLEAN" as const};
      return { record, deduplicated: true, url: input.issueSignedUrl===false?undefined:await this.storage.signedUrl(record.objectKey, 300) };
    }

    const scan = await this.scanner.scan(input.bytes, declared);
    if (scan.state !== "CLEAN") {
      throw new MediaValidationError(
        scan.state === "INFECTED" ? "Malware detected" : "Media scanner unavailable",
        scan.state === "INFECTED" ? "MALWARE" : "SCAN_UNAVAILABLE",
        { retryable: scan.state === "ERROR", quarantine: scan.state === "INFECTED" },
      );
    }

    const now = new Date();
    const id = crypto.randomUUID();
    // A content-addressed key makes concurrent deduplication idempotent. The
    // original filename remains metadata and is never trusted as a path.
    const key = `${input.tenantId}/sha256/${digest.slice(0, 2)}/${digest}`;
    const candidate:MediaRecord={
      id,
      tenantId: input.tenantId,
      sha256: digest,
      objectKey: key,
      mimeType: declared,
      byteSize: input.bytes.length,
      scanState: "CLEAN",
      createdAt: now.toISOString(),
      expiresAt,
    };
    let reservation:MediaReservation;
    try{reservation=await this.repository.reserve(candidate)}catch{
      throw new MediaValidationError("Media reservation is temporarily unavailable","MEDIA_RESERVATION_UNAVAILABLE",{retryable:true,quarantine:false});
    }
    if(reservation.sha256!==digest||reservation.objectKey!==key||reservation.mimeType!==declared||reservation.byteSize!==input.bytes.length){
      throw new MediaValidationError("Existing media reservation does not match its content", "MEDIA_RESERVATION_CONFLICT");
    }
    if(reservation.scanState==="CLEAN"){
      const record={...reservation,scanState:"CLEAN" as const};
      return{record,deduplicated:true,url:input.issueSignedUrl===false?undefined:await this.storage.signedUrl(record.objectKey,300)};
    }
    await this.storage.put(key, input.bytes, {
      tenant_id: input.tenantId,
      sha256: digest,
      mime_type: declared,
      scan_engine: scan.engine,
    });
    let record:MediaRecord;
    try{record=await this.repository.promote(candidate)}catch{
      throw new MediaValidationError("Media promotion is temporarily unavailable","MEDIA_PROMOTION_UNAVAILABLE",{retryable:true,quarantine:false});
    }
    return { record, deduplicated: record.id !== id, url: input.issueSignedUrl===false?undefined:await this.storage.signedUrl(record.objectKey, 300) };
  }
}
