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

Use test mode while rehearsing the flow:

```text
http://localhost:8000/event-ticketing-debugged.html?test=1
```

Live mode is the normal URL without `?test=1`.

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

Important notes:

- The URL works only while this computer is on, online, and both commands are running.
- Quick Tunnel URLs are temporary and can change when restarted.
- Ticket and request data is saved on this machine in `data/storage.json`.
- This is still a lightweight trust-based app. The admin PIN hides the staff UI, but the API is not hardened against technical abuse.

