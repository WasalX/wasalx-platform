import { Injectable } from "@nestjs/common";

@Injectable()
export class RoutingConnectorsConfig {
  readonly externalConnectorsEnabled =
    process.env.CLIENT_ROUTING_EXTERNAL_CONNECTORS_ENABLED === "true";
  readonly notionOAuthClientId = process.env.NOTION_OAUTH_CLIENT_ID?.trim() ?? "";
  readonly notionOAuthClientSecretReference = process.env.NOTION_OAUTH_CLIENT_SECRET_REFERENCE?.trim() ?? "";
  readonly portalBaseUrl = portalBaseUrl(process.env.PUBLIC_PORTAL_BASE_URL);
  readonly notionOAuthEnabled = this.externalConnectorsEnabled && Boolean(this.notionOAuthClientId && this.notionOAuthClientSecretReference && this.portalBaseUrl);
  readonly notionOAuthRedirectUri = this.portalBaseUrl ? new URL("/api/client-routing/oauth/notion/callback", this.portalBaseUrl).toString() : "";

  constructor(){if(this.notionOAuthClientSecretReference&&!/^secret:\/\/[A-Za-z0-9][A-Za-z0-9._~:/-]*$/u.test(this.notionOAuthClientSecretReference))throw new Error("NOTION_OAUTH_CLIENT_SECRET_REFERENCE is invalid")}
}

function portalBaseUrl(value:string|undefined){if(!value)return"";const url=new URL(value);if(process.env.NODE_ENV==="production"&&url.protocol!=="https:")throw new Error("PUBLIC_PORTAL_BASE_URL must use HTTPS in production");if(url.protocol!=="https:"&&!(url.protocol==="http:"&&(url.hostname==="localhost"||url.hostname==="127.0.0.1")))throw new Error("PUBLIC_PORTAL_BASE_URL is invalid");url.pathname="/";url.search="";url.hash="";return url.toString()}
