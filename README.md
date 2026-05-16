# FUB Pipeline Scrub — Web App
## Deploy to Railway (free, 5 minutes)

A web app you can open from any browser, any device, anywhere.

---

## What you need
- Free GitHub account → https://github.com
- Free Railway account → https://railway.app (sign up with GitHub)

---

## Step 1 — Put files on GitHub

1. Go to https://github.com and sign in
2. Click the **+** icon → **New repository**
3. Name it `fub-scrub` → click **Create repository**
4. On the next screen click **uploading an existing file**
5. Upload these files keeping the folder structure:
   ```
   server.js
   package.json
   public/
     index.html
   ```
6. Click **Commit changes**

---

## Step 2 — Deploy on Railway

1. Go to https://railway.app and sign in with GitHub
2. Click **New Project**
3. Click **Deploy from GitHub repo**
4. Select your `fub-scrub` repository
5. Railway auto-detects Node.js and deploys it
6. Wait ~2 minutes for the build to finish

---

## Step 3 — Get your URL

1. In Railway, click your project → **Settings** tab
2. Under **Networking** → click **Generate Domain**
3. You'll get a URL like: `fub-scrub-production.up.railway.app`
4. **Bookmark that URL** — that's your app, accessible from anywhere!

---

## Using the app

1. Open your Railway URL in any browser (phone, tablet, laptop)
2. Paste your FUB API key — it saves in your browser automatically
3. Click **Load agents** then **Run full scrub**
4. Browse the 6 tabs:
   - 🆕 New leads (48h)
   - 🔄 Stage changes (48h)
   - 📝 New notes (48h)
   - 🏠 Home/website activity (7d)
   - 💬 Communications (48h)
   - 🔇 No contact ever (ponds included)
5. Click **Copy scrub for Claude.ai** → paste into claude.ai for analysis

---

## Notes
- Your FUB API key is stored only in your browser (localStorage) — it never touches Railway's servers
- Railway free tier = $5 credit/month. This app uses ~$0.50-1/month so it runs essentially free
- The URL is permanent — bookmark it once and use it forever
- Works on mobile too

---

## Updating the app later
If you want to make changes, just update the files on GitHub and Railway redeploys automatically.
