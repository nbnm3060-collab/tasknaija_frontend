# TaskNaija architecture

TaskNaija is a TanStack Start / React / TypeScript app on Netlify. Its design uses green, white, and dark navy, with Manrope headings and DM Sans body text. Do not add animations or invented user activity.

## Key directories

- `src/routes`: separate file routes for every public, account, checkout, and admin page. `__root.tsx` owns metadata and the document shell. The router generates its own route tree during deployment.
- `src/components/tasknaija/app.tsx`: shared public and workspace layouts, account context, all page components, forms, dialogs, and admin actions.
- `src/lib/tasknaija.ts`: shared view types, pricing presentation, formatting helpers, same-origin API client. No credentials or trusted monetary calculations belong here.
- `src/styles.css`: responsive design system and all product styles. Preserve keyboard focus and mobile layouts; use no animations.
- `netlify/functions/api.mts`: authenticated API, persistent rate limiting, Paystack integration, admin actions. Use v2 Functions and `Netlify.env.get`.
- `netlify/edge-functions/admin-guard.ts`: server-side admin page guard. It calls `/api/me` to share the API's authoritative authorization and suspension checks.
- `db/schema.ts`: canonical Drizzle schema. `db/index.ts` lazily creates a Netlify Database adapter. Always install Drizzle ORM and Kit from the beta tag required by this adapter.
- `netlify/database/migrations`: generated schema migrations, automatically applied at deployment. Generate a new migration for every schema edit; never change applied migrations.
- `.netlify/features/netlify-identity`: deployment activation marker, intentionally included despite local Netlify files being ignored.

## Security and domain rules

Identity owns passwords, email confirmation, and sessions. Use the Identity SDK rather than custom password storage. All server auth mutations verify the request origin. Client callbacks handle confirmation, invitation, and recovery. Server-side authorization derives admin access only from `ADMIN_EMAIL` plus a confirmed authoritative Identity account; editable metadata never grants access. Suspended users cannot access member APIs. Sensitive admin endpoints authorize every request independently of UI visibility.

Prices are server-owned: Basic 15000, Standard 30000, Premium 50000 kobo. Require verified Paystack success, NGN, exact amount, recorded reference, customer email, and user/plan metadata before activation. Webhooks verify raw-body HMAC before processing, then call the same payment verification logic. Payment reference locking makes activation idempotent. When PAYSTACK_SECRET_KEY is absent, show a clear checkout-unavailable placeholder and reject payment initialization before inserting a payment. Never simulate payment success or subscription activation. Never log secrets or banking information.

A subscription lasts 30 days. Access is checked at read and submission time against the latest created subscription. Same-plan renewal extends remaining time; changing plans starts anew. Subscriptions are lazily expired through timestamp comparison, so no cron is needed to enforce expiry.

One submission per user/task. Snapshot the task reward when submitting; only approved submissions credit the wallet. All monetary amounts are integer kobo. Approval, wallet change, ledger insertion, and audit record are atomic. Wallet rows serialize credits and withdrawals. Unique submission/withdrawal ledger references prevent duplicate financial effects.

Minimum withdrawal is 100000 kobo. Pending and Approved requests reserve funds. Only Approved requests can become Paid, requiring a real unique bank transfer reference. Paying is an administrative record after an external manual transfer, not an automated transfer API. Only Paid requests debit the wallet. Rejected requests release reservations. Never offer arbitrary balance edits. Preserve financial records by disallowing task deletion when submissions exist.

## Working conventions

Use strict TypeScript, validate untrusted input with Zod, escape displayed text through React, and provide pending, error, empty, and success states. Forms disable themselves while submitting. Protect API responses from caching. Add persistent data only through Netlify Database; do not use local storage, local JSON, or in-memory objects as a database. Never seed fake balances, tasks, payment confirmations, or users.

Use the environment's current validation policy. This project's managed build run prohibits local build, test, typecheck, and dev-server validation commands; source review and file-generation tools are permitted, and deployment validates builds automatically. Identity flows require a deployed environment.
