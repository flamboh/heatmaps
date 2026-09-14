# Deployment

Requirements: Bun 1.3+, a Cloudflare Workers Paid account, a
[Last.fm API key](https://www.last.fm/api/account/create). GitHub counts come
from the public profile calendar and need no token. Private contribution
counts are included when the profile owner has made them public.

1. Install dependencies:

   ```sh
   bun install
   ```

2. Log in and create the KV namespace:

   ```sh
   bunx wrangler login
   bunx wrangler kv namespace create ACTIVITY_CACHE
   ```

3. Replace the existing `account_id` and KV namespace `id` in `wrangler.jsonc`
   with the values for your Cloudflare account.

4. Add the API key as an encrypted secret:

   ```sh
   bunx wrangler secret put LASTFM_API_KEY
   ```

5. Deploy:

   ```sh
   bun run deploy
   ```

## Continuous deployment

GitHub Actions verifies and deploys every push to `main`. Add a repository
Actions secret named `CLOUDFLARE_API_TOKEN` containing a Cloudflare API token
with permission to deploy this Worker. The workflow can also be run manually
from GitHub's Actions page.

For local development, copy `.dev.vars.example` to `.dev.vars`, add the API
key, and run `bun run dev`. Do not commit `.dev.vars`.
