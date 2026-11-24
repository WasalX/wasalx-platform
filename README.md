# WasalX platform

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

Use the same handoff value in both services. The worker applies these limits
when scheduling additional retries, and the control API uses the handoff limit
when an operator brings forward an already scheduled retry. Invalid values fail
startup with the variable name in the error.
