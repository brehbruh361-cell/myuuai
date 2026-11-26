MYUUAI - BUILD UPDATE

FILES
- index.html: dashboard
- worker.js: Cloudflare Worker backend
- wrangler.toml: Worker configuration

IMPORTANT SECURITY
Never put provider API keys in index.html, GitHub Pages source, or browser settings.
Store keys in Cloudflare Worker > Settings > Variables and Secrets.

MAGIC HOUR MULTI-KEY
Recommended secret:
Name: MAGIC_HOUR_API_KEYS
Value: paste multiple Magic Hour API keys separated by commas or new lines.

Legacy compatibility:
MAGIC_HOUR_API_KEY is still supported as a single/backup key.
The Worker tries another configured key when a key returns 401, 402, 429, or a provider server error.
Multiple keys do not combine credits across separate accounts unless the provider itself allows it.

OTHER SECRETS
- ELEVENLABS_API_KEY (optional, sound effects)
- APP_ACCESS_TOKEN (optional but recommended; if configured, enter the same token in MyuuAI Settings)

DEPLOY
1. Upload index.html to the frontend hosting used by the project.
2. Upload worker.js and wrangler.toml to the Cloudflare Worker project.
3. In Cloudflare Worker Settings > Variables and Secrets, add the secrets above.
4. Keep the Workers AI binding named AI in wrangler.toml for automatic subtitles.
5. Deploy the Worker, then open MyuuAI > Settings > Periksa Koneksi.

VIDEO QUALITY
The new Low / Medium / High / Ultra selector adds visual-detail guidance to the video prompt.
Actual render resolution and model availability remain controlled by the selected video model and provider plan.
