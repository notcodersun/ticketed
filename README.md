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
ADMIN_PASSWORD="use-a-long-random-password" npm start
```

If you do not set `ADMIN_PASSWORD`, the development fallback is `2026`. Do not use that for the real event link.

Optional but recommended: set a stable session secret so admin sessions survive a server restart:

```sh
ADMIN_PASSWORD="use-a-long-random-password" SESSION_SECRET="another-long-random-string" npm start
```

The admin password is checked by the server. Successful login creates an HttpOnly session cookie. Guest browsers can submit payment verification requests and check their own status, but raw storage listing, ticket creation, approvals, check-in updates, dashboards, and CSV export require the admin session.

## EmailJS Ticket Template

The styled EmailJS HTML body is in `emailjs-ticket-template.html`.

In EmailJS, open the ticket template, switch to the HTML/source editor, and paste that file's contents as the message body. The app sends these fields:

```text
{{to_email}} {{to_name}} {{event_name}} {{event_datetime}} {{event_date}} {{event_doors}}
{{venue_name}} {{venue_link}} {{ticket_code}} {{ticket_index}} {{ticket_total}} {{ticket_label}}
{{ticket_price}} {{qr_image}} {{qr_url}} {{rules_text}}
```

Set the template's recipient/to email field to `{{to_email}}`.

## Server-Side Email With Nodemailer

The app now tries the backend Nodemailer endpoint first and keeps EmailJS as a browser fallback.

To send real emails from the server, start with SMTP settings:

```sh
ADMIN_PASSWORD="use-a-long-random-password" \
SESSION_SECRET="another-long-random-string" \
SMTP_HOST="smtp.example.com" \
SMTP_PORT="587" \
SMTP_USER="smtp-user" \
SMTP_PASS="smtp-password" \
SMTP_FROM="M.U.M Tickets <tickets@example.com>" \
npm start
```

If `SMTP_HOST` and `SMTP_FROM` are not set, the admin email log will show that Nodemailer is wired but skipped. That is expected for local feasibility testing.

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
