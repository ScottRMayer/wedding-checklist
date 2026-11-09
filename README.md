# Wedding Build

A shared wedding-planning checklist, built like a construction checklist: decisions with each option's trade-offs, to-dos by phase, a vendor and payment sheet, and a budget. The couple and the people they invite sign in and work from the same live data.

This repository holds only the app code. The checklist content and all planning data live in a Supabase database behind sign-in and row-level security, so nothing personal is in this repo or served to anyone who is not on the guest list.

## How it is built

- Static site: `index.html`, `styles.css`, `app.js` (vanilla JS modules), served by GitHub Pages.
- `config.js` holds the Supabase project URL and the publishable key. The publishable key is designed to be public; access is enforced by database policies tied to the signed-in user's email.
- `reference.js` holds non-personal reference tables (the 2027 halachic calendar, a run-of-show template, packing lists, sources).
- Supabase provides email-and-password accounts, the Postgres tables (`phases`, `items`, `vendors`, `budget`, `members`, `activity`), and realtime updates.

## Access

Only emails on the `members` table can read or write. Owners manage that list from the People tab in the app. Someone who signs up with an email that is not on the list sees an empty "not on the guest list" screen.

## Local development

Serve the folder with any static server, for example `python3 -m http.server 8080`, and open `http://localhost:8080/`. The app talks to the live Supabase project, so you need an account on the guest list to see data.
