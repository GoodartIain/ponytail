# Milestone tracker

Status reflects code in this folder, not intent.

| # | Milestone | Status |
|---|---|---|
| 0 | Architecture and foundation | Design docs done (`ARCHITECTURE.md`); repo + test runner done. Stack deviation: no Next.js/Postgres yet (see debt). |
| 1 | Accounts and campaign creation | **Done (dev auth).** Worlds with ruleset/advancement/autonomy/calendar/visibility settings, campaigns with inherited or overridden advancement, confirmed mode switch, single-use player/spectator invites, server-side roles. |
| 2 | Worldbuilding and hierarchical maps | **Partial.** Location tree, per-location map (image URL + pins) and wiki page, breadcrumbs, visibility tiers, GM notes, stable ids. Missing: rich text, backlinks, search, version history, discovery state. |
| 3–13 | Tabletop, characters, comms, 3D, spectator broadcast, downtime, NPCs, … | Not started (designed in `ARCHITECTURE.md`). |

## Vertical slice acceptance

`create world → campaign → configure advancement → create town → add location → link map + wiki page → invite player → navigate world map → town → location`

- Automated: `node --test test/*.test.js` — passes (also checks spectator/player/GM visibility, rename stability, persistence, event log).
- Manual (Chromium via Playwright): GM builds Aster → Greyhaven → Gilded Gull + hidden Smugglers Den, invites player; player navigates by map pin and list, sees lore, does not see GM notes or the hidden place. Passed.

## Known debt / defects

- Auth is a display name + bearer token in localStorage. Replace with real accounts (OIDC or email magic link) before any public hosting.
- Storage is one JSON file rewritten per mutation; fine for one table, not for concurrent servers. Move to Postgres per ERD.
- No rate limiting, no CSRF concern yet (bearer header, no cookies).
- Map images are external URLs, not uploaded assets.
- Next.js / Tailwind / Prisma from the preferred stack are not introduced yet: the slice did not need them. Introduce with Milestone 3 (PixiJS tabletop) when a build step pays for itself.

## Recommended next action

Milestone 2 completion: per-campaign discovery state and Postgres migration, then Milestone 3 (PixiJS scene with tokens over WebSocket).
