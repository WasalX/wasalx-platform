const basePolicy = "default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self' data:; form-action 'self'; frame-ancestors 'none'; frame-src 'none'; img-src 'self' data: blob:; media-src 'self' blob:; object-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:";

export function portalContentSecurityPolicy(pathname: string) {
  if (pathname !== "/app") return basePolicy;
  // Embedded Signup is loaded only by connection setup. Keep its documented SDK
  // and login transports confined to the tenant portal, with no wildcard hosts.
  return basePolicy
    .replace("connect-src 'self';", "connect-src 'self' https://www.facebook.com https://graph.facebook.com;")
    .replace("frame-src 'none';", "frame-src https://www.facebook.com https://staticxx.facebook.com;")
    .replace("img-src 'self' data: blob:;", "img-src 'self' data: blob: https://connect.facebook.net;")
    .replace("script-src 'self' 'unsafe-inline';", "script-src 'self' 'unsafe-inline' https://connect.facebook.net;");
}
