# Control API list pagination

`GET /v1/connections` returns an array ordered by creation time and ID, newest first.
A page contains up to 200 rows by default. Set `limit` to an integer from 1 to 200
to request fewer rows. When the response includes `X-Next-Cursor`, pass that value
as `cursor` on the same route. An absent header marks the last page. Cursors are
relative to the authorized tenant and the current list. Start from the first page
when the cursor row has been removed.

The `GET /v1/team` response includes separate `members_next_cursor` and
`invitations_next_cursor` values. The first request returns both lists the caller
may read. Pass a cursor as `member_cursor` or `invitation_cursor` to continue
the corresponding list. A continuation only reads lists with a supplied cursor.
A null cursor marks the end of that list. The `limit` applies per list.
