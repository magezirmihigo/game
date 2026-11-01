# eFootball Arena

Run real knockout tournaments (4, 8 or 16 players) with friends. Accounts, a randomly drawn bracket,
private room codes, scores that both players must confirm, and disputes settled with screenshot proof.

No dependencies. Needs only **Node 18 or newer**.

## Run it

```
node server.js
```

Open http://localhost:3000. To try it on phones on the same Wi-Fi, open `http://<your-computer-IP>:3000`.

**Test alone:** create a cup, then press **Fill with test bots & start**. Bots share room codes and
report scores, so you can play a whole tournament by yourself.

## How a match works

1. The organizer creates a cup; friends join; the organizer starts it (bracket is drawn at random).
2. The first player listed in a match is the **host**. They create the room in eFootball and paste the
   room code. Only the two players (and the organizer/admin) can see it.
3. After the game, **both players enter the final score**. Players cannot see each other's report until
   both have submitted. Matching reports confirm the result and the winner moves on.
4. Different reports open a **dispute**. Players can correct their report and upload a screenshot.
   The organizer (if not playing in that match) or an admin rules on it.
5. No-show? The organizer/admin can award a forfeit.

eFootball has no public match API, so scores are self-reported and verified by agreement plus
screenshots. There are no draws: enter the score including extra time or penalties (winner higher).

## Who is admin?

- On a fresh server, **the first account registered becomes admin**. Register yours immediately.
- On a public deployment, set `ADMIN_USERNAME=yourname` instead. Then only that username becomes admin.

## Deploy so friends can join from anywhere

Any host that runs Node works. A `render.yaml` is included.

**Important:** data (accounts, tournaments, screenshots) is stored in files under `DATA_DIR`
(default `./data`). Hosts with a wiped-on-restart filesystem, such as Render's free plan, will lose
everything. Use a persistent disk (Render paid plan with disk, Railway volume, or a small VPS) and
point `DATA_DIR` at it. Run **one instance only**.

Environment variables: `PORT` (set by the host), `DATA_DIR`, `ADMIN_USERNAME`,
`TRUST_PROXY=0` (only if you run it directly on the internet with no proxy in front).

## Tests

```
node test.js
```

Plays complete tournaments against a temporary data folder: permissions, room-code privacy,
dual confirmation, disputes, proof uploads, forfeits, bots, live updates, rate limiting.

## What it does not do (yet)

- No password reset or email; an admin cannot reset passwords. Pick passwords people will remember.
- No payments or prizes. If you add entry fees, check your local gambling and payment rules.
- Storage is a JSON file: fine for friends and communities (hundreds of users), not for thousands.
  `store.js` is the only file to replace to move to PostgreSQL.
- Screenshots are reviewed by a human; there is no automatic image verification.
- "eFootball" is a Konami trademark. Consider a name of your own before promoting this publicly.

## Files

- `server.js`: HTTP API, auth, permissions, live updates (Server-Sent Events)
- `engine.js`: bracket, scoring, disputes, bots (pure logic)
- `store.js`: JSON-file persistence
- `public/`: the web app (HTML, CSS, JS; no build step)
- `test.js`: automated tests
