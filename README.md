# Poshak – clothing store (Phase 1)
Run locally: `npm install && ADMIN_PASSWORD=yourpass npm start` → http://localhost:3000 (shop), /admin.html (admin).
Go live: push to GitHub, deploy on Render/Railway/VPS. Set env vars ADMIN_PASSWORD and DB_PATH (point to a persistent disk, e.g. /data/store.db). Then connect your domain (HTTPS is automatic on Render/Railway).
Next phases: bKash/SSLCommerz payments, courier API (Pathao/Steadfast), product photo upload, order SMS, login.
