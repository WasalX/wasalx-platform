import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import {
  constants,
  createHash,
  createPublicKey,
  publicEncrypt,
  randomBytes,
} from "node:crypto";

export type InvitationTokenEnvelope = {
  token: string;
  tokenHash: string;
  ciphertext: Buffer;
  keyVersion: string;
};

@Injectable()
export class InvitationTokenService {
  issue(): InvitationTokenEnvelope {
    const token = Buffer.from(randomBytes(32)).toString("base64url");
    const ciphertext = publicEncrypt(
      {
        key: encryptionPublicKey(),
        padding: constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256",
      },
      Buffer.from(JSON.stringify({ token }), "utf8"),
    );
    return {
      token,
      tokenHash: createHash("sha256").update(token).digest("hex"),
      ciphertext,
      keyVersion: cleanKeyVersion(process.env.INVITATION_TOKEN_KEY_VERSION ?? "v1"),
    };
  }
}

function encryptionPublicKey() {
  const configured = process.env.INVITATION_TOKEN_ENCRYPTION_PUBLIC_KEY;
  if (!configured) {
    throw new ServiceUnavailableException(
      "Invitation delivery public key is not configured",
    );
  }
  try {
    return configured.includes("BEGIN PUBLIC KEY")
      ? createPublicKey(configured)
      : createPublicKey({ key: Buffer.from(configured, "base64"), format: "der", type: "spki" });
  } catch {
    throw new ServiceUnavailableException(
      "Invitation delivery public key is invalid",
    );
  }
}

function cleanKeyVersion(value: string) {
  const normalized = value.trim();
  if (!normalized || normalized.length > 100 || hasControlCharacters(normalized)) {
    throw new ServiceUnavailableException("Invitation encryption key version is invalid");
  }
  return normalized;
}

function hasControlCharacters(value: string) {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}
