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
- **Links** — [DELIVERY.md](DELIVERY.md) and [DESIGN.md](DESIGN.md). The project follows the portfolio engineering standard and delivery-orchestration skill, both private. Every rule contributors must follow is stated in `AGENTS.md` and `DELIVERY.md`.
- The owner decides only money (any paid service), access only the owner can grant, production deployments, destructive operations on real data, making private things public, and closing a project. Project leads decide everything else within their scopes.

## Product and current goal

WasalX helps support teams handle WhatsApp conversations in tenant workspaces, with routing, automation, and Zammad case handoff.
The current goal is to qualify the first-client alpha with simulated-provider operator journeys on the application stack.
Live-provider qualification is a separate release milestone.

## Commands

- Set up with a supported Node.js version and the pnpm version pinned in [package.json](package.json). Run `corepack enable` and `pnpm install --frozen-lockfile`.
- Use `pnpm run docker:up` for the fixture-backed local stack. Supply the required development values from [.env.example](.env.example) in a local environment. The stack includes PostgreSQL, Redis, the secret sidecar, the control API, and workers. Use `pnpm run docker:down` to stop it.
- Use `pnpm run dev` to run the portal from source with the dependencies needed by the journey. The full Compose profile adds Keycloak, object storage, provider adapters, and Zammad. Start it with `docker compose -f compose.yaml -f compose.full.yaml --profile full up --build`. Use disposable data and supply the values required by that profile.
- For affected checks, use `pnpm run lint`, `pnpm run typecheck`, and the relevant test runner. For a focused Node test, use `node --test path/to/test-file.mjs` after building its prerequisites.
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
- Reuse the existing shared boundary. Keep routing, rules, flows, handoff, privacy, and audit provider-neutral. Keep tenant configuration versioned and immutable after activation.
- Fail closed at tenant, identity, authorization, secret, and external-action boundaries. Preserve tenant-bound foreign keys, PostgreSQL row-level security, idempotency, durable leases, and redacted audit evidence.
- Extend Zammad through package-owned code and verified extension points. Never patch Zammad core. Require compatibility coverage for upgrades.
- Use the design tokens and Impeccable for UI work. Keep the interface clear, responsive, keyboard accessible, and localized in English and Arabic with correct RTL layout. Verify affected operator journeys in a real browser.
- Trace affected journeys across the UI, API, database, workers, and integrations. Cover non-trivial changes with a focused regression. Distinguish simulated, live-provider, and deployed evidence.

## Risk paths

Require the [risk-path review](DELIVERY.md#branching-and-merging) for paths in [CODEOWNERS](CODEOWNERS), including `AGENTS.md`, `DELIVERY.md`, `CLAUDE.md`, and `tests/no-agent-instruction-files.test.mjs`. The same review applies to migrations, identity and authorization, privacy and retention, and production configuration.

## Data safety

- Use additive, compatible migrations and test existing-data upgrades, tenant isolation, failure recovery, and rollback. Keep applied migration history intact.
- Before changing persistent data, confirm the affected tenancy and recovery path. Verify a restorable backup before replacing state.
- Obtain owner approval for destructive operations on real data. Use synthetic fixtures and disposable infrastructure for tests.

## Privacy

Keep personal names, private hosts and paths, addresses, credentials, secrets, and real customer or staff data out of commits, issues, PRs, and CI output. Follow the [pre-push privacy check](DELIVERY.md#privacy-checks).

## Release and deploy

Follow [DELIVERY.md](DELIVERY.md) for qualification, approvals, digest promotion, deploys, and rollback. Bind each result to the exact commit and, for deployments, the admitted image digests.
