# Supabase setup

The app uses Supabase Auth for username/password verification and a same-origin Next.js backend for every browser operation. The browser does not connect to Supabase directly. Do not restore the former anon-key/browser RLS design.

Apply the four migrations in timestamp order. The repository does not include generated Supabase CLI project settings; for first-time CLI use, run `supabase init` and review the created `supabase/config.toml`, then link the intended project with `supabase link --project-ref <project-ref>`. Apply with `supabase migration up --linked`. Alternatively execute the full files in `migrations/` in order in the SQL Editor. Stop if any migration fails. `schema.sql` is only a pointer to those migrations.

Create the first password account through the application, then run the one-time operator bootstrap from a trusted machine using the deployment server's service role secret:

```powershell
$env:SUPABASE_URL = "https://project-ref.supabase.co"
$env:SUPABASE_SERVICE_ROLE_KEY = "<service-role-secret>"
node scripts/bootstrap-admin.mjs first_username
```

This accepts an existing active username once. It does not create accounts or send email. After success, bootstrap cannot run again. Keep the service role secret off shared machines and clear the shell environment when finished.

## Auth configuration

Set hosted Auth minimum password length to 8 and configure upstream rate limits. The app enforces new/reset passwords as at least 8 Unicode code points, one uppercase English letter, one printable ASCII punctuation symbol, and at most 72 UTF-8 bytes. Existing passwords remain valid for login. The hosted Auth policy enum does not offer this exact character combination; do not require lowercase or digits there. The app's rule is enforced by the BFF registration and reset routes. Hosted Auth endpoints may still be called directly, so configure Auth-level rate limits and verify after deployment that a rejected direct sign-up rolls back at the database trigger.

Registration is public. The device ceiling is two account registrations per browser-device random signed cookie, not a person limit; it does not fingerprint hardware. Clearing browser data or switching browsers changes the device token. The Auth trigger remains the authoritative atomic quota enforcement and direct sign-up guard.
