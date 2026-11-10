# TaskNaija

TaskNaija is a Nigerian task and reward platform with 30-day subscriptions, reviewed proof submissions, an auditable wallet, and administrator-managed bank withdrawals. The app includes public pages, a member workspace, and a protected administrator dashboard. No example tasks, accounts, earnings, or payment confirmations are seeded.

## Technologies

React 19, TypeScript, TanStack Start and Router, Vite, Lucide icons, and responsive CSS. Netlify Identity handles password hashing, account confirmation, sessions, logout, and password recovery. Netlify Database provides managed Postgres through `@netlify/database` and Drizzle ORM. Netlify Functions implement the API; an Edge Function protects the admin page. Paystack hosts checkout and verifies Nigerian Naira subscription payments.

## Running locally

Use Node 22.13+ or Node 24 and pnpm.

```sh
pnpm install
netlify link
netlify dev --port 8889
```

Identity authentication needs a deployed HTTPS site; it is not emulated by Netlify Dev. Use a Deploy Preview for registration, login, callbacks, and payments. Deployment automatically applies migrations from `netlify/database/migrations`. Generate future migrations with `pnpm exec drizzle-kit generate --name descriptive_change_name`. Do not run schema push against production.

## Configuration

Set `PAYSTACK_SECRET_KEY` and `ADMIN_EMAIL` as runtime environment variables for the deployment contexts you use. Never commit credentials. The key is only read by the server and no public key is required for hosted checkout. The included activation marker enables Netlify Identity on deployment.

When `PAYSTACK_SECRET_KEY` is absent, checkout displays an explicit unavailable state and the server rejects payment initialization before creating a payment record. No payments or subscriptions are simulated. Adding the key enables the real integration automatically on subsequent requests. `ADMIN_EMAIL` is configured for production and deploy previews.

Register and confirm the email configured as `ADMIN_EMAIL`, then log in at `/login` and visit `/admin`. Admin privileges are calculated on the server from the configured email and the authoritative confirmed Identity account. Changing the configured administrator email changes authorization on subsequent requests. Profile metadata cannot grant privileges. All sensitive admin actions also check authorization independently of the page guard.

In your Paystack dashboard, configure this webhook URL:

```
https://nigerian-task-platform.netlify.app/api/paystack-webhook
```

Use the appropriate deployed hostname for previews or custom domains. Match the Paystack test/live mode to the configured secret. Callback URLs are generated from the checkout request origin. The webhook verifies the raw request HMAC and independently verifies payment with Paystack. Browsers can explicitly check pending payments using Transaction History. No subscription is activated by a redirect alone.

## Operating the platform

Publish real tasks in the administrator dashboard. Every task needs instructions, a category, a reward, and a difficulty. Users require the matching active subscription and can submit each task once. Review proof manually before approving. Rewards are stored at submission time so subsequent task edits do not change a pending submission’s reward. Deactivate tasks with submissions rather than deleting financial history.

The Basic, Standard, and Premium plans cost ₦150, ₦300, and ₦500 respectively. They last 30 days with no automatic recurring billing. Same-plan renewal extends remaining time; changing plans starts a fresh 30 days. Expired members keep their wallet and history but cannot access or submit tasks.

All monetary amounts are integer kobo. Pending and approved withdrawals reserve funds to prevent overcommitment, but do not debit the wallet. The minimum request is ₦1,000. Administrators approve requests, manually make a bank transfer, then enter its actual unique transfer reference and mark the request Paid. Marking Paid records the debit; it does not initiate a bank transfer. Bank details are entered by the user and must be checked by the administrator before transferring.

Credits and debits use row locks, database transactions, unique ledger references, and a nonnegative balance constraint. Approval and payment actions enforce allowed state transitions. There is no endpoint for arbitrary balance changes. Support requests and replies persist in the database. Authentication and sensitive user actions have persistent database-backed rate limits.

## Validation

Source files and generated SQL were reviewed during implementation. Local build, test, and development-server commands were not run in the managed build session; the deployment pipeline performs build validation. Real account, payment, webhook, and manual payout flows must be exercised on a configured deployed environment before accepting live payments.
