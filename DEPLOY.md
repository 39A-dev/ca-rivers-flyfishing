# Deploying to the web (GitHub Pages)

The app is a static Vite build. This repo ships a GitHub Actions workflow
(`.github/workflows/deploy.yml`) that builds and publishes `dist/` to GitHub
Pages on every push to `main`.

Your **data** already lives in ArcGIS (TroutBookDev org) — deploying only puts
the *viewer* on the web.

## One-time setup

### 1. Create the repo + push
```bash
# from the project root
gh auth login                       # browser auth, once
gh repo create ca-rivers-flyfishing --public --source=. --remote=origin --push
```
(Pages on a **free** account requires a **public** repo. The API key is NOT in
the code — it's injected from a secret below — so public is safe here.)

### 2. Add the API key as a build secret (never committed)
```bash
gh secret set VITE_ARCGIS_API_KEY < <(grep VITE_ARCGIS_API_KEY .env.local | cut -d= -f2-)
# or paste it interactively:  gh secret set VITE_ARCGIS_API_KEY
```

### 3. Turn on Pages (GitHub Actions source)
Repo → **Settings → Pages → Build and deployment → Source = GitHub Actions**.
The next push (or a manual “Run workflow”) deploys. Your URL will be:
```
https://<your-github-username>.github.io/ca-rivers-flyfishing/
```

### 4. 🔑 Register that URL with ArcGIS (or sign-in + routing break)
In the **Location Platform dashboard**:
- **OAuth credential** (CA Rivers Field App OAuth) → add redirect URL
  `https://<username>.github.io/ca-rivers-flyfishing/` (must be HTTPS).
- **API key** (routing) → add `<username>.github.io` to its allowed HTTP referrers.

### 5. Decide layer sharing
Your BMI / Stream Health / Road Closures / enriched layers are **private**:
- Public viewers should see data without signing in → share those layers to
  **Everyone** in ArcGIS (editing still requires OAuth sign-in).
- Otherwise keep them private; every visitor signs in.

### 6. Enable pay-as-you-go (or watch the free tier)
The dashboard currently shows *pay-as-you-go disabled* — past the free monthly
allowance (basemaps, routing, storage) requests will **fail rather than bill**.
Enable it or monitor usage before sharing the link widely.

## Local dev unchanged
`npm run dev` reads the key from `.env.local` (gitignored). Nothing about
deployment changes the localhost workflow.

## Alternatives
Prefer **Netlify** or **Vercel**? Connect the GitHub repo, set build command
`npm run build`, output dir `dist`, and add `VITE_ARCGIS_API_KEY` as an env var.
Same ArcGIS steps (4–6) apply with that host's URL instead.
