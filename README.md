# Ocean Edge Games

Ocean Edge Games is a React and Express tournament platform backed by Supabase PostgreSQL. Authentication is implemented in the Express server; Supabase Auth is not used.

## Requirements

- Node.js 20 or newer
- A Supabase PostgreSQL connection string (`DATABASE_URL`) with permission to create the schema
- Gmail SMTP credentials to deliver verification and recovery codes
- Razorpay test keys for checkout (payments remain unavailable until test credentials are configured)

## Setup

1. Copy `.env.example` to `.env` and fill the server-side values. Never put `SUPABASE_SECRET_KEY`, `DATABASE_URL`, SMTP credentials, Razorpay secrets, or `SESSION_SECRET` in client variables.
2. Install dependencies with `npm install`.
3. Apply every SQL migration in `database/migrations` in numeric order (`001_initial.sql` through `005_player_game_accounts_artwork_levels.sql`) using the Supabase SQL editor or `psql`.
4. Start both applications with `npm run dev`. The client is at `http://localhost:5173`, and the API is at `http://localhost:5000/api`.

The first server boot can create the configured administrator using `ADMIN_EMAIL` and `ADMIN_PASSWORD`. The password is hashed and is never stored in source control. Admin login is available at `/pass/ads`.

## Operations and limits

- PostgreSQL is the source of truth. Financial and reward operations use database transactions and idempotency constraints.
- OG points are ledgered separately from XP and cash rewards. Levels use a monotonic curve from 10 points for level 2 to 10,000 cumulative points for level 100; see `server/src/domain/progression.js`.
- Razorpay entry-fee checkout is test-mode only. Admins can instead enable QR/UPI manual checkout, upload a private QR image, and configure the receiving UPI ID. Manual submissions remain pending until an authorized administrator confirms funds; screenshots are never treated as payment confirmation. Payment-method changes affect new registrations, while existing registrations retain their original method and QR/UPI snapshot. Private images use the configured Supabase Storage bucket. No live Razorpay or automated payout integration is enabled. Administrators can record an externally completed reward payout with its transfer reference; the record itself does not move funds. Webhook signature verification requires the exact raw request body.
- Gmail OTP and password recovery need valid SMTP settings. Missing integrations return an explicit service-configuration error; the app does not claim an email was sent.
- The refund rule blocks entry-fee refunds in the final 48 hours before the configured tournament start. Refund eligibility is checked on the server.
- User uploaded profile art is not accepted. Profile art must reference an administrator-approved asset record.

## Commands

- `npm run dev` — run client and server
- `npm run build` — create the client bundle and syntax-check the server
- `npm test` — run server domain and validation tests

## Deployment

Serve the client over HTTPS, set `NODE_ENV=production`, use a long random `SESSION_SECRET` and stable `OEG_OTP_PEPPER`, restrict `CLIENT_URL` to the deployed origin, and use a Supabase database role with only the required application privileges. Configure the Razorpay webhook endpoint as `/api/payments/webhook` only after test verification. Run the SQL migration before starting the server.
