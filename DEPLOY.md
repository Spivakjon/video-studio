# Deploy — making the dashboard online

The editor dashboard is a Node.js HTTP server. Deploying it makes the web UI accessible from any device (phone, other computers, clients).

## What works online vs. local

| Feature | Online (Railway/JetServer) | Local only |
|---------|---------------------------|------------|
| Browse videos + edit texts | ✅ | |
| Edit copy, voice, metadata | ✅ | |
| Upload assets | ✅ | |
| Generate TTS (Gemini API) | ✅ (needs `GEMINI_API_KEY`) | |
| View budgets / spend logs | ✅ | |
| Project discovery (scan disk) | ❌ disabled online | ✅ |
| Run `npm run render` | ❌ needs Chrome/Puppeteer | ✅ on your PC |
| Vertex AI Veo (`npm run veo`) | ⚠ needs SA key | ✅ via `gcloud auth` |

**Strategy:** deploy the dashboard online so you can edit/review from anywhere. Keep rendering + Veo local (your PC). Workflow:

1. Edit copy on phone / remote PC via online dashboard
2. Back at your PC: `git pull` → `npm run render -- <project>`
3. `git add renders/ && git commit && git push`
4. Next deploy picks up the new MP4

## Option A — Railway (recommended for speed)

### One-time setup

1. Go to https://railway.com → sign up / log in (GitHub OAuth).
2. **New Project** → **Deploy from GitHub repo** → choose `Spivakjon/video-studio`.
3. Railway detects Node.js, runs `npm run studio`. Default healthcheck hits `/api/projects`.
4. Add environment variables under **Variables**:
   - `GEMINI_API_KEY` = your key (same one on your Windows env)
   - `GCP_PROJECT_ID` = `kikkaboo-490323` (optional — only for Veo; budget UI works without)
   - `NODE_ENV` = `production`
5. **Deploy** → Railway gives you a public URL like `https://video-studio-production.up.railway.app`.
6. **Settings → Domain** → Generate railway subdomain OR add your own custom domain.

### Every update after that

```bash
git add . && git commit -m "your message" && git push
# Railway auto-redeploys on push
```

### Cost

- Hobby plan: **$5 / month** (includes $5 usage credit)
- For dashboard-only traffic: usually stays within credit
- If traffic grows: pay-as-you-go

## Option B — JetServer (your own server)

If you already pay for JetServer, this is zero marginal cost.

You'll need SSH access. Once you have it, share with me:
- SSH host + user
- Do you have `node` and `pm2` installed?
- Do you have nginx or another reverse proxy?

Then I'll walk you through:
1. `git clone` on the server
2. `npm install`
3. Run via `pm2 start "npm run studio" --name video-studio`
4. Point nginx at port 3003 with SSL via Let's Encrypt

## Option C — Cloudflare Tunnel (zero deploy, local stays authoritative)

Fastest option if you only occasionally need remote access. The dashboard runs on your PC; Cloudflare gives it a public URL.

```bash
# Install (PowerShell, admin):
winget install Cloudflare.cloudflared

# Run (when you want remote access):
cloudflared tunnel --url http://localhost:3003
```

You get a URL like `https://xxxx.trycloudflare.com`. Valid while your PC + tunnel are running.

---

## Which to pick?

- **Want to work from phone tomorrow morning?** → Cloudflare Tunnel, 2 minutes.
- **Want a permanent URL clients can bookmark?** → Railway.
- **Want full control and no recurring cost?** → JetServer.

Mix is also fine: Railway for the permanent URL + local rendering, move to JetServer later if Railway gets expensive.
