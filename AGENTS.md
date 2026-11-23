# WasalX agent instructions

## Project facts

- Repository [WasalX/wasalx-platform](https://github.com/WasalX/wasalx-platform). The main branch is `main`.
- The private [project board](https://github.com/orgs/WasalX/projects/1) has the pinned **Project brief**.
- The GitHub environments are `dev`, `stg`, and `prod`. See [environment use and data rules](DELIVERY.md#environments).
- Milestones: v0.1.0 (current) and v0.2.0 (next). Dates and scope are on the [repo milestones](https://github.com/WasalX/wasalx-platform/milestones).
- Lead threads are WasalX Master, WasalX Delivery, and WasalX Design.
- UI project: yes
- Other repos: WasalX/wasalx-zammad-addon
- [Delivery rules](DELIVERY.md) define how changes ship.
- **Links** — [DELIVERY.md](DELIVERY.md) and [DESIGN.md](DESIGN.md). The project follows the portfolio engineering standard and delivery-orchestration skill, both private. Contributor rules are in this file, [DELIVERY.md](DELIVERY.md) and [SECURITY.md](SECURITY.md).
- The owner decides only money (any paid service), access only the owner can grant, production deployments, destructive operations on real data, making private things public, and closing a project. Project leads decide everything else within their scopes.

## Product and current goal

WasalX helps support teams handle WhatsApp conversations in tenant workspaces, with routing, automation, and Zammad case handoff.
The current goal is to qualify the first-client alpha with simulated-provider operator journeys on the application stack.
Live-provider qualification is a separate release milestone.

## Commands

- Set up with a supported Node.js version and the pnpm version pinned in [package.json](package.json). Run `corepack enable` and `pnpm install --frozen-lockfile`.
- Use `pnpm run docker:up` for the fixture-backed local stack. Supply the required development values from [.env.example](.env.example) in a local environment. The stack includes PostgreSQL, Redis, the secret sidecar, the control API, and workers. Use `pnpm run docker:down` to stop it.
- Use `pnpm run dev` to run the portal from source with the dependencies needed by the journey. The full Compose profile adds Keycloak, object storage, provider adapters, and Zammad. Start it with `docker compose -f compose.yaml -f compose.full.yaml --profile full up --build`. Use disposable data and supply the values required by that profile.
- Build the portal with `pnpm run build` and the services with `pnpm run build:services`.
- For affected checks, use `pnpm run lint`, `pnpm run typecheck`, and the relevant test runner. For a focused Node test, use `node --test path/to/test-file.mjs` after building its prerequisites.
- There is no formatter command yet. See the [delivery deviations](DELIVERY.md#deviations).
- Run the root suite with `pnpm test`. Unit tests require a Ruby toolchain for the add-on. Database integration uses `pnpm run test:postgres` with disposable PostgreSQL and both admin and application database URLs. Browser integration uses `pnpm run test:e2e` with Playwright Chromium and its fixture services. Run the full release checks through CI. See [Checks](DELIVERY.md#checks).

## Architecture and single sources

- Fixture-backed portal, control API, worker, and service topology — [compose.yaml](compose.yaml).
- Production-like local topology and the full profile — [compose.full.yaml](compose.full.yaml).
- Local smoke overrides — [compose.smoke.yaml](compose.smoke.yaml).
- Published image catalog and build inputs — [scripts/release/product-images.json](scripts/release/product-images.json).
- Installer stages and admission — [scripts/release/installer-stages.mjs](scripts/release/installer-stages.mjs).
- Tenant database schema and RLS evolution — [control API migrations](services/control-api/migrations/).
- UI design tokens — [app/design-system/tokens.css](app/design-system/tokens.css).
- Release acceptance — [docs/release.md](docs/release.md).

## Coding rules and definition of done

- Keep each PR independently reviewable. Name its issue when one exists and describe the scope, checks, and evidence tied to its head.
- Search for something to reuse before adding a module, file, table, configuration key, workflow, or dependency. Say what you searched in the PR.
- Read environment, host, and tenant values from configuration.
- Reuse the existing shared boundary. Keep routing, rules, flows, handoff, privacy, and audit provider-neutral. Keep tenant configuration versioned and immutable after activation.
- Store business configuration as schema-validated rows. Reject invalid rows and identify the rejected row in the error.
- Fail closed at tenant, identity, authorization, secret, and external-action boundaries. Preserve tenant-bound foreign keys, PostgreSQL row-level security, idempotency, durable leases, and redacted audit evidence.
- Deny access by default on the server and test authorization for each role.
- Validate inputs against their schemas at every trust boundary.
- Store and compare instants in UTC. Convert to the user's time zone for display.
- Make jobs, webhooks, and message handlers idempotent. Set timeouts and bounded retries with backoff for outbound calls.
- Use structured logs with a request or trace ID. Identify people and records by ID only.
- Paginate lists that can grow.
- Extend Zammad through package-owned code and verified extension points. Never patch Zammad core. Require compatibility coverage for upgrades.
- Use the design tokens and Impeccable for UI work. Meet WCAG 2.2 AA, source English and Arabic text from translation files, and check RTL layout. Verify affected operator journeys in a real browser.
- Trace affected journeys across the UI, API, database, workers, and integrations. Distinguish simulated, live-provider, and deployed evidence.
- Include a test that fails without each behavior change. Use a controlled clock, avoid sleeps, and limit network calls to local test services.
- Update affected documentation in the same PR as the change.
- Follow the [branch and merge rules](DELIVERY.md#branching-and-merging) and the [security policy](SECURITY.md).

## Risk paths

Require the [risk-path review](DELIVERY.md#branching-and-merging) for paths in [CODEOWNERS](CODEOWNERS), including `AGENTS.md`, `DELIVERY.md`, `CLAUDE.md`, and `tests/no-agent-instruction-files.test.mjs`. The same review applies to migrations, identity and authorization, privacy and retention, and production configuration.

## Data safety

- Use additive, compatible migrations and test existing-data upgrades, tenant isolation, failure recovery, and rollback. Use expand/contract for destructive changes and never edit applied migrations.
- Before changing persistent data, confirm the affected tenancy and recovery path. Verify a restorable backup before replacing state.
- Obtain owner approval for destructive operations on real data. Use synthetic fixtures and disposable infrastructure for tests.

### Personal data

- **Staff identity** — Users, memberships, invitations, operator requests, and audit actor IDs in the control database.
- **Customer contacts** — WhatsApp participant IDs and phone numbers, group participants, and coexistence contacts in the control database.
- **Messages and media references** — Normalized messages, raw webhooks in the event inbox, delivery outbox payloads, media references, bot conversations, and group history in the control database.
- **Privacy records and email routing** — Privacy requests, holds, export records, and email-routing applications in the control database.
- **Help desk and identity provider** — Help-desk tickets, articles, attachments, and customer and agent contact data in help-desk storage. Staff accounts and credentials in the identity provider's database.
- **Object storage and backups** — Media and privacy exports in object storage. Backups can contain copies of database and help-desk data.
- **Outside processors** — The email provider receives invitee email addresses. WhatsApp providers receive recipients and message content.
- **Logs** — Structured application logs identify people and records by ID and redact sensitive fields by key.

Tenant retention settings keep resolved cases and media for 1 to 3,650 days, with a default of 90 days. Group history uses its own setting with the same range and default. Unmatched webhook diagnostics are eligible for purge within 24 hours, subject to legal holds. Privacy exports expire within 168 hours.

Privacy deletion and export requests stay within the tenant and can target the tenant, a ticket, a reference, a participant, or a help-desk user. Active legal holds block applicable deletions. The WhatsApp provider's data-deletion callback also accepts requests.

## Privacy

Keep personal names, private hosts and paths, addresses, credentials, secrets, and real customer or staff data out of commits, issues, PRs, and CI output. Follow the [pre-push privacy check](DELIVERY.md#privacy-checks).

## Release and deploy

Follow [DELIVERY.md](DELIVERY.md) for qualification, approvals, digest promotion, deploys, and rollback. Bind each result to the exact commit and, for deployments, the admitted image digests.
