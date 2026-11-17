export type IdentityPolicyActivatorConfig = {
  port: number;
  databaseUrl: string;
  issuer: string;
  audience: string;
  jwksUri: URL;
};

export function loadIdentityPolicyActivatorConfig(
  environment: NodeJS.ProcessEnv = process.env,
): IdentityPolicyActivatorConfig {
  const production = environment.NODE_ENV === "production";
  const issuer = issuerUrl(required(environment.IDENTITY_POLICY_ATTESTATION_ISSUER, "IDENTITY_POLICY_ATTESTATION_ISSUER"), production);
  const jwksUri = new URL(required(environment.IDENTITY_POLICY_ATTESTATION_JWKS_URI, "IDENTITY_POLICY_ATTESTATION_JWKS_URI"));
  if (
    !["http:", "https:"].includes(jwksUri.protocol) || jwksUri.username || jwksUri.password ||
    jwksUri.hash || (production && jwksUri.protocol !== "https:")
  ) {
    throw new Error("IDENTITY_POLICY_ATTESTATION_JWKS_URI must be an HTTPS URL in production");
  }
  const audience = boundedToken(
    required(environment.IDENTITY_POLICY_ATTESTATION_AUDIENCE, "IDENTITY_POLICY_ATTESTATION_AUDIENCE"),
    "IDENTITY_POLICY_ATTESTATION_AUDIENCE",
  );
  return {
    port: integer(environment.PORT, 8086, 1, 65_535, "PORT"),
    databaseUrl: required(environment.IDENTITY_POLICY_DATABASE_URL, "IDENTITY_POLICY_DATABASE_URL"),
    issuer,
    audience,
    jwksUri,
  };
}

function issuerUrl(value: string, production: boolean) {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) || url.username || url.password ||
    url.search || url.hash || (production && url.protocol !== "https:")
  ) {
    throw new Error("IDENTITY_POLICY_ATTESTATION_ISSUER must be an HTTPS issuer in production");
  }
  return url.toString().replace(/\/$/u, "");
}

function boundedToken(value: string, name: string) {
  if (value.length < 3 || value.length > 200 || hasControlOrWhitespace(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function integer(raw: string | undefined, fallback: number, minimum: number, maximum: number, name: string) {
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function required(value: string | undefined, name: string) {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function hasControlOrWhitespace(value: string) {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 32 || code === 127 || character.trim() === "";
  });
}
