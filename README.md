# Poshak – clothing store

## Local development

1. Start PostgreSQL: `npm run postgres:up`
2. Build the client: `npm run build`
3. Start the server: `npm start`

The shop is available at `http://localhost:3000`; the admin dashboard is at `/admin` or `/admin.html`.

## Render deployment

Configure these environment variables in the Render service:

- `DATABASE_URL`: use the Render PostgreSQL connection string.
- `PGSSL=true`
- `NODE_ENV=production`
- `JWT_SECRET`: a long random secret.
- `ADMIN_EMAIL`: the dashboard login email.
- `ADMIN_PASSWORD`: a strong admin password.

After every password change or deployment where the environment values changed, redeploy so `ensureAdminAccount()` updates the account.

### Database and images

A Render PostgreSQL database does not contain your local SQLite products automatically. To copy the local database, run the migration with the Render `DATABASE_URL`, for example using Render Shell:

```bash
node scripts/migrate-to-postgres.js --apply
```

Uploaded product files are written to the directory selected by `UPLOAD_DIR` (default: `public/uploads`). Render's local disk is ephemeral unless an attached persistent disk/object storage is used. For a persistent disk, set `UPLOAD_DIR=/var/data/uploads` and attach a disk at `/var/data`. For the free tier, use full HTTPS image URLs from the admin dashboard instead; uploaded files will otherwise disappear on redeploy.
