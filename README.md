# WasalX platform

## Direct ticket replies

When delivery starts for an agent's WhatsApp reply, the connector independently
requests a read receipt and a typing indicator for the latest inbound message
linked to that ticket when the reply was queued. Each inbound message is
claimed once. Unsupported capabilities and exhausted signal retries are
recorded separately from reply delivery. Meta combines both signals in one
request, while WAHA uses two requests and targets the specific inbound ID.

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
