# Control API list pagination

`GET /v1/connections` returns an array ordered by creation time and ID, newest first.
A page contains up to 200 rows by default. Set `limit` to an integer from 1 to 200
to request fewer rows. When the response includes `X-Next-Cursor`, pass that value
as `cursor` on the same route. An absent header marks the last page. Cursors are
relative to the authorized tenant and the current list. Start from the first page
when the cursor row has been removed.
