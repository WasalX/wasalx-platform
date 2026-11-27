# WasalX platform

See [Meta upstream message cost estimates](docs/runbooks/meta-cost-reference-tariff.md) for the provider rate catalog and tariff upload.

## Platform console responses

The shared [platform client](lib/platform-client.ts) expects a JSON body on
success and rejects responses it cannot parse. Use `{ response: "empty" }` only
for an endpoint that documents HTTP 204 No Content. That option resolves with
`undefined`. HTTP errors keep their status, and a 401 sends the operator to
sign-in with the current return location.

## Zammad ticket context

`GET /internal/v1/zammad/tickets/:ticketId/context` returns
`service_window_expires_at` as a UTC ISO 8601 instant. It is the latest known
inbound customer message time for the ticket's direct conversation plus the
connection provider's customer-service window. Past instants indicate a closed
window. The field is `null` for group tickets, providers without a window, or
when the inbound timestamp is unavailable.

## Bot delivery retry limits

Set these optional variables in the service environment. For the Compose stack,
set them in the project `.env` file. See [.env.example](.env.example) for the
defaults. Each limit includes the initial attempt.

| Variable | Services | Valid values |
| --- | --- | --- |
| `BOT_ACTION_MAX_ATTEMPTS` | Connector worker | Integers from 1 to 25 |
| `BOT_HANDOFF_MAX_ATTEMPTS` | Connector worker and control API | Integers from 1 to 8, the database limit for a handoff job |

For Helm, set `connectorRetries.botActionMaxAttempts` and
`connectorRetries.botHandoffMaxAttempts` in your values file. See the
[chart defaults](infra/helm/wasalx/values.yaml). Helm passes both values to the
control API and connector worker from those shared settings.

When setting environment variables directly, use the same handoff value in
both services. The worker applies these limits when scheduling additional
retries, and the control API uses the handoff limit when an operator brings
forward an already scheduled retry. Invalid values fail startup with the
variable name in the error.

## Direct ticket replies

The connector independently requests a read receipt for the latest eligible
inbound message linked to the ticket when the reply was queued. It requests a
typing indicator while the reply is still sending. Meta combines the signals
when both apply. WAHA uses separate requests and targets the specific inbound ID.
Each inbound message is claimed once, and signal failures leave the reply
delivery result intact.

## WhatsApp marketing preferences

Subscribe the Meta app to the [`user_preferences` webhook](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/user_preferences).
WasalX records signed Stop and Resume events and Meta delivery error `131050`.
After a Stop, template delivery requires a verified non-marketing category.
Without a recorded Stop, marketing templates continue under the usual delivery rules.
Service replies continue through the normal delivery rules. The audit log records
preference changes and refused sends by ID.

Group jobs have no direct recipient, so WasalX refuses group marketing templates.
The refusal message currently reports that the contact stopped marketing messages.
A synchronous `131050` records the Stop in the delivery failure transaction. An
expired lease rolls back that observation, and a later rejection can record it.
Preferences apply across all WhatsApp Business Accounts in a tenant. A newer
Resume on one number clears the same contact's Stop on another.

## Optional portal mutation bodies

The Notion authorization start, delivery retry, and privacy request retry
endpoints accept an omitted body or a JSON object. Their optional fields are
`integrationId` (string), `confirmOutcomeUnknown` (boolean), and `confirmation`
(string), respectively. Malformed JSON, a non-object body, or a field with
the wrong type returns HTTP 400 before the operation is dispatched.
