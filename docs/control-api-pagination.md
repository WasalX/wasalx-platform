# Control API list pagination

The bot-flow, action, action revision, routing version, and media asset lists
under `/v1/bot-flows` also return arrays with the `X-Next-Cursor` header. For
media, an initial page may also include explicitly requested ready assets.
Keep those `id` parameters on subsequent requests so those assets appear only
once. The no-query conversations response also includes the header when more
rows exist. Continue with its cursor and a `limit` from 1 to 100 to receive
the existing conversation page object.

`GET /v1/connections` returns an array ordered by creation time and ID, newest first.
A page contains up to 200 rows by default. Set `limit` to an integer from 1 to 200
to request fewer rows. When the response includes `X-Next-Cursor`, pass that value
as `cursor` on the same route. An absent header marks the last page. Cursors are
relative to the authorized tenant and the current list. Start from the first page
when the cursor row has been removed.
