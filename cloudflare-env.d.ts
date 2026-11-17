declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    ASSETS: Fetcher;
    IMAGES: {
      input(stream: ReadableStream): {
        transform(options: Record<string, unknown>): {
          output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
        };
      };
    };
    WAHA_WEBHOOK_SECRET?: string;
    WAHA_BASE_URL?: string;
    ZAMMAD_BASE_URL?: string;
    ZAMMAD_SERVICE_JWT_SECRET?: string;
    META_APP_SECRET?: string;
    META_VERIFY_TOKEN?: string;
    META_GRAPH_VERSION?: string;
    META_EDGE_TENANT_ID?: string;
    META_EDGE_CONNECTION_ID?: string;
  }
}
