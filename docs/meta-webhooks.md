# Meta webhook apps

Set `META_WEBHOOK_APPS_FILE` on the control API to the path of a read-only JSON
configuration file. Keep one row per app in the deployment's versioned
configuration. The API validates the registry on startup and holds a snapshot
until restart. The registry must include `META_APP_ID` with the same secret
reference as `META_APP_SECRET_REFERENCE`. The API resolves that row's verification
token on startup and requires it to match `META_VERIFY_TOKEN`. The file contains
sidecar references only.

```json
{
  "schemaVersion": 1,
  "apps": [
    {
      "appId": "10001",
      "secretReference": "secret://example/meta/10001/hmac",
      "verifyTokenReference": "secret://example/meta/10001/verify"
    },
    {
      "appId": "10002",
      "secretReference": "secret://example/meta/10002/hmac",
      "verifyTokenReference": "secret://example/meta/10002/verify"
    }
  ]
}
```

For each app, set the callback to the control API's
`/webhooks/meta/apps/<appId>`. Give each app its own Meta app secret and
verification token. In the sidecar, use `hmacKey` or `value` for each referenced
secret and use a verification token of at least 16 bytes. During webhook requests,
the control API resolves only the credential for the requested app and method.

The tenant's existing Meta webhook route must have the app's HMAC secret
reference. The API admits events only to matching routes and records the app ID
on queued events. Apply migrations and update both the control API and connector
worker before enabling the registry. When the registry is enabled,
`/webhooks/meta` selects the registered `META_APP_ID`. Without a registry, the
existing callback uses the single-app environment configuration.

The registry configures webhook ingress for existing app-bound connections.
Embedded Signup, outbound app selection, and the data-deletion callback still
use the environment's default app.
