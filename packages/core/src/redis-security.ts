export type RedisRuntimeEnvironment = {
  NODE_ENV?: string;
  WASALX_ENVIRONMENT?: string;
};

export function validatedRedisUrl(
  raw: string,
  environment: RedisRuntimeEnvironment = process.env,
  name = "REDIS_URL",
) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} must be a valid Redis URL`);
  }

  if (!url.hostname || url.search || url.hash || !["redis:", "rediss:"].includes(url.protocol)) {
    throw new Error(`${name} must be an undecorated redis:// or rediss:// URL`);
  }

  if (url.protocol === "rediss:") {
    if (!url.username || !url.password) {
      throw new Error(`${name} must include an ACL username and password`);
    }
    if (isProduction(environment) && decodeURIComponent(url.username) === "default") {
      throw new Error(`${name} must use a dedicated ACL user in production`);
    }
    return raw;
  }

  if (isProduction(environment) || (!isLocalRuntime(environment) && !isLoopback(url.hostname))) {
    throw new Error(`${name} must use authenticated TLS outside local development or test`);
  }
  return raw;
}

function isProduction(environment: RedisRuntimeEnvironment) {
  return environment.NODE_ENV === "production" && environment.WASALX_ENVIRONMENT !== "local-full";
}

function isLocalRuntime(environment: RedisRuntimeEnvironment) {
  return ["development", "test"].includes(environment.NODE_ENV ?? "") ||
    ["development", "test", "local-full"].includes(environment.WASALX_ENVIRONMENT ?? "");
}

function isLoopback(hostname: string) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}
