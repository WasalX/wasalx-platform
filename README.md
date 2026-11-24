# WasalX platform

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

## WhatsApp marketing preferences

Subscribe the Meta app to the [`user_preferences` webhook](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/user_preferences).
WasalX records signed Stop and Resume events and Meta delivery error `131050`.
After a Stop, template delivery requires a verified non-marketing category.
Service replies continue through the normal delivery rules. The audit log records
preference changes and refused sends by ID.
