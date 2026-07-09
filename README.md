# Ticketed

A small event ticketing page with a shared Node.js storage backend.

## Run Locally

```sh
npm start
```

Open:

```text
http://localhost:8000
```

Admin/staff view:

```text
http://localhost:8000/admin.html
```

Use test mode while rehearsing the flow:

```text
http://localhost:8000/event-ticketing-debugged.html?test=1
http://localhost:8000/admin.html?test=1
```

Live mode is the normal URL without `?test=1`.

## Admin Security

Set a strong admin password before sharing the public URL:

```sh
npm start
```

Secrets are read from `.env`. This local checkout already has generated `ADMIN_PASSWORD` and `SESSION_SECRET` values in `.env`.

If you do not set `ADMIN_PASSWORD`, the development fallback is `2026`. Do not use that for the real event link.

Optional but recommended: set a stable session secret so admin sessions survive a server restart:

```sh
SESSION_SECRET="another-long-random-string"
```

The admin password is checked by the server. Successful login creates an HttpOnly session cookie. Guest browsers can submit payment verification requests and check their own status, but raw storage listing, ticket creation, approvals, check-in updates, dashboards, and CSV export require the admin session.

## Render Persistent Storage

Ticket data must live on a Render persistent disk, otherwise deploys and restarts can erase requests and sold tickets.

The safest setup is Postgres. Set these Render environment variables from Neon, Supabase, Render Postgres, or another managed Postgres provider:

```text
DATABASE_URL="postgres://user:password@host:5432/database"
DATABASE_SSL="true"
```

When `DATABASE_URL` is present, tickets, requests, and email logs are stored in Postgres instead of Render's disappearing local filesystem. The app creates the required `ticketed_store` table automatically.

To keep current ticket data during migration:

1. Before changing storage, download `GET /api/admin/export-storage`.
2. Add `DATABASE_URL` in Render environment variables.
3. Deploy the app.
4. While logged in as admin, send the exported JSON to `POST /api/admin/import-storage`.

The import merges records and does not delete existing database records.

This repo includes `render.yaml` with:

```yaml
disk:
  name: ticket-data
  mountPath: /var/data
  sizeGB: 1
```

The server writes `storage.json` to `DATA_DIR=/var/data` and automatic backup snapshots to `/var/data/backups`.
Use this disk option only if the Render service plan supports persistent disks.

If the existing Render service was not created from the blueprint, add the disk manually in the Render Dashboard:

1. Open the `mum-tickets` service.
2. Go to **Disks**.
3. Add a disk with mount path `/var/data`.
4. Add environment variables `DATA_DIR=/var/data` and `BACKUP_DIR=/var/data/backups`.
5. Redeploy once.

## Email Ticket Template

The styled EmailJS HTML body is in `emailjs-ticket-template.html`.

In EmailJS, open the ticket template, switch to the HTML/source editor, and paste that file's contents as the message body. The app sends these fields:

```text
{{to_email}} {{to_name}} {{event_name}} {{event_datetime}} {{event_date}} {{event_doors}}
{{venue_name}} {{venue_link}} {{ticket_code}} {{ticket_index}} {{ticket_total}} {{ticket_label}}
{{ticket_price}} {{qr_image}} {{qr_url}} {{rules_text}}
```

Set the template's recipient/to email field to `{{to_email}}`.

## Server-Side Ticket Email

The app sends ticket emails from the backend and records every attempt in the admin email log.
The email QR is generated from the same ticket code used by the check-status section, and the QR PNG is attached to the email.

Use Resend when Render blocks Gmail SMTP:

```text
RESEND_API_KEY="re_..."
EMAIL_FROM="M.U.M Tickets <myth.official.music7@gmail.com>"
EMAIL_CC="42sannay@gmail.com"
```

Or use SMTP/Nodemailer:

```text
SMTP_HOST="smtp.example.com"
SMTP_PORT="587"
SMTP_USER="smtp-user"
SMTP_PASS="smtp-password"
SMTP_FROM="M.U.M Tickets <myth.official.music7@gmail.com>"
SMTP_CC="42sannay@gmail.com"
```

Put those values in `.env`, then run `npm start`. If Resend is configured, it is tried first; otherwise the app uses Nodemailer. If no email provider is configured, the admin email log will show the send as skipped.

## Free Public URL With Cloudflare Quick Tunnel

Keep the server running:

```sh
npm start
```

In a second terminal, run:

```sh
cloudflared tunnel --url http://localhost:8000
```

Cloudflare prints a random public `https://...trycloudflare.com` URL. Share that URL with guests.
Use `/admin.html` on the same public URL for staff.

Important notes:

- The URL works only while this computer is on, online, and both commands are running.
- Quick Tunnel URLs are temporary and can change when restarted.
- Ticket and request data is saved on this machine in `data/storage.json`.
- Use a strong `ADMIN_PASSWORD` before sharing the staff URL.
