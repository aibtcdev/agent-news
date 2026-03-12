We need three values from the Cloudflare account that runs the current `aibtc.news` Pages app:

**1. Account ID**
- Go to Cloudflare dashboard → Workers & Pages → the Account ID is in the right sidebar

**2. API Token with KV read access**
- Go to `dash.cloudflare.com/profile/api-tokens`
- Create Token → Custom Token
- Permission: `Account` / `Workers KV Storage` / `Read`
- Scope it to the account that runs aibtc.news

**3. KV Namespace ID**
- Go to Workers & Pages → KV
- Find the namespace bound as `SIGNAL_KV` in the aibtc.news Pages app
- Copy the namespace ID

Please share all three values so we can run the data migration to the new infrastructure.
