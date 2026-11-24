# WasalX platform

See [Meta upstream message cost estimates](docs/runbooks/meta-cost-reference-tariff.md) for the provider rate catalog and tariff upload.

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

## Direct ticket replies

The connector independently requests a read receipt for the latest eligible
inbound message linked to the ticket when the reply was queued. It requests a
typing indicator while the reply is still sending. Meta combines the signals
when both apply. WAHA uses separate requests and targets the specific inbound ID.
Each inbound message is claimed once, and signal failures leave the reply
delivery result intact.
