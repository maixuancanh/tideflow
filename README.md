# Tideflow

Tideflow is a playable harbor operations game built around one simple idea:

> Live onchain activity becomes port traffic, container demand, and yard decisions.

The player runs a small container harbor. Nansen provides the activity signal; the game turns that signal into vessel arrivals and container manifests. The player decides where each vessel is received, then the harbor handles the physical work while the player monitors capacity, equipment, transfers, and rewards.

The project is designed as a readable hackathon demo rather than a trading terminal. Nansen is the input layer for the simulation. It does not ask the player to trade, connect a wallet, or sign a transaction.

## Play the demo

- **Live demo:** [tideflow-production-1d74.up.railway.app/study.html](https://tideflow-production-1d74.up.railway.app/study.html)
- **Local game page:** `http://127.0.0.1:4317/study.html`

The interface is in English. The default profile starts at Coral Harbor. Jade Harbor is an optional harbor item that can be purchased from the shared shop.

## Why Nansen is part of the game

Without a live data source, a harbor game can still move ships on a timer, but every arrival is arbitrary. Tideflow uses Nansen activity to give the operations a reason to exist:

1. Recent transfer activity creates container batches with chain, token, transaction, and observation metadata.
2. Recent DEX activity can create a short-lived demand signal with a bounded quantity and premium adjustment.
3. Those batches become incoming vessels and manifests in the harbor.
4. The player chooses a receiving harbor, berth, and stacking strategy.
5. The resulting yard pressure affects what the player can accept, unload, store, and transfer.

This makes the data visible through play. A change in onchain activity is expressed as a change in port traffic and container demand, rather than as a number on a dashboard.

If Nansen is unavailable, the game does not invent new onchain events. It keeps previously saved, validated data and labels the feed as **Stale** or **Offline**. The harbor can still display saved state, while new arrivals wait for a valid feed.

## The game loop

### 1. Loading and launch

Opening `/study.html` shows only the harbor loading artwork, the Tideflow logo, a real asset progress bar, and a short status message. The Babylon scene, models, textures, profile, and data state are prepared before the **PLAY** button appears. After PLAY, the camera starts above the harbor, travels through dense clouds, and settles on the full harbor view before the HUD fades in.

### 2. Incoming vessel

Validated Nansen batches are placed in an automatic arrival queue. When a vessel is ready, Tideflow shows an **Incoming vessel** notification. The notification names the vessel and its container count. The player can accept or cancel the arrival. If another panel is already open, the notification becomes a compact message below the Nansen status chip instead of covering the active panel.

### 3. Receiving and unloading

For an accepted vessel, the player selects:

- the receiving harbor;
- an available berth;
- a stacking strategy: priority, compact, or balanced.

After confirmation, the vessel sails to the selected berth. The crane, forklift, truck, and yard sequence runs automatically. Each container keeps its chain, token, source batch, and Nansen provenance while it moves through the operation. A completed voyage pays NS; cancelling or abandoning a claimed arrival can apply the configured penalty.

### 4. Managing the yard

The **Manage** panel is the operations view. It shows capacity, occupied container positions, berth activity, equipment, queue pressure, and the harbor metrics that matter to the next decision.

**Manage containers** opens the transfer flow. Containers are presented as compact items with an icon and progress indicator. A selected item offers **Inland delivery** or **Sea transfer**. Locked or unavailable items are visibly disabled. The player confirms the transfer after choosing a destination and quantity.

Yard capacity belongs to the harbor upgrade path. It is not a shop item and it is not shared between harbors.

### 5. Record and replay

The **Record** panel keeps the latest completed voyages for each owned harbor. Each record shows the chain, container count, NS result, and a **View replay** action. A replay can show the recorded schedule and the manifest source without creating a second payment or mutating live operations.

### 6. Shop and harbor ownership

The shop is shared at the operation level. It contains:

- **Jade Harbor**, which unlocks another harbor with its own yard, berths, and capacity progression;
- **Forklift**, which is added to shared equipment storage after purchase;
- **Yard crane**, which is added to shared equipment storage after purchase.

Equipment is not installed on every harbor at once. In **Manage**, the player equips a purchased forklift or yard crane to one owned harbor. The assignment is saved per harbor, so each port has its own installed equipment while the shop remains shared.

## HUD and interface

- **Top left:** Tideflow wordmark and the current operational context.
- **Top right:** captain profile, NS balance, and Nansen status.
- **Center world view:** the two harbors, vessels, berths, cranes, yard, workers, and containers.
- **Harbor hover card:** storage, equipment, and the harbor upgrade action. It closes immediately when the pointer leaves, when another popup opens, or when the player clicks outside it.
- **Bottom command dock:** Record, Shop, and Manage. The icons use the same compact, circular, single-style visual language as the NS icon and brighten on selection.
- **Minimap:** a static terrain illustration of the harbor with the current position and traffic markers. It is intentionally a lightweight image so it does not compete with the Babylon scene.

The visual system uses dark frosted glass for the HUD and popups: backdrop blur, saturation, hairline borders, a soft sheen, and one warm yellow accent (`#FFD000`). All popup close buttons stay in the top-right corner, and clicking outside an open popup closes it.

## Technical architecture

| Area | Implementation |
| --- | --- |
| 3D scene | Babylon.js, TypeScript, custom harbor geometry, camera and cloud animation |
| Frontend | Vite-served HTML and TypeScript modules |
| Harbor simulation | `src/study/operations.ts`, arrival queue, berth routing, resource scheduling, yard placement |
| Persistent state | Single-writer JSON adapter in `server/harborState.ts` |
| Nansen feed | Server-only handler in `server/nansenPlugin.ts` |
| UI | DOM panels and HUD mounted by `src/study/tideflowHud.ts` and the study modules |
| Static assets | `public/brand`, `public/study`, and `public/models` |
| Production server | Bundled Node server in `server/standalone.ts` |

The server keeps session state, claimed manifests, port saves, equipment assignments, export reservations, and Nansen feed evidence outside the browser. Writes are serialized through one local JSON store and use temporary-file replacement so a completed write is durable before it replaces the previous state.

## Nansen integration

Nansen calls are made only by the server. The browser receives validated feed data and never receives an API key.

The feed handler:

- accepts multiple keys through `NANSEN_API_KEYS`;
- rotates to the next key after `401`, `403`, or `429` responses;
- temporarily cools down failing keys;
- caches slower endpoints and enforces per-poll and hourly request budgets;
- keeps a durable feed so a slow refresh does not block the UI;
- accepts only recent, schema-checked transfer and DEX rows;
- stores source provenance with every accepted batch and demand term;
- serves saved data with an explicit stale/unavailable status when refresh fails.

`NANSEN_API_KEY` is still accepted as a compatibility fallback for a single key, but `NANSEN_API_KEYS` is preferred for failover.

## Run locally

Requirements:

- Node.js 22 (Node 20.19 or newer also works with the Vite toolchain)
- npm

Install dependencies:

```powershell
npm.cmd install
```

Create a local environment file from the safe template:

```powershell
Copy-Item .env.example .env
```

Set your own server-side key list in `.env` when you want live Nansen data:

```dotenv
NANSEN_API_KEYS=your_key_1,your_key_2
```

Do not commit `.env`. The included `.env.example` intentionally contains no credential.

Start the development server:

```powershell
npm.cmd run dev
```

Open [http://127.0.0.1:4317/study.html](http://127.0.0.1:4317/study.html).

Build and run the standalone server:

```powershell
npm.cmd run build
npm.cmd run build:server
npm.cmd start
```

The standalone server serves the built frontend and exposes:

- `GET /healthz` for liveness;
- `GET /readyz` for build and storage readiness;
- `GET /api/harbor/session` for the current browser session;
- `POST /api/harbor/session` for validated game mutations;
- `GET /api/harbor/feed` for the server-owned Nansen feed.

For a public HTTPS deployment, set `HOST=0.0.0.0`, `HARBOR_PUBLIC_ORIGIN=https://...`, and `HARBOR_SECURE_COOKIE=true`. The start script creates a local session secret when one is not supplied; production deployments should provide a stable `HARBOR_SESSION_SECRET` through the host's secret manager.

## Project layout

```text
study.html                 Loading screen and study entry point
src/study/                 Babylon scene, harbor loop, HUD, panels, and data flow
server/                    Session persistence and Nansen server integration
scripts/                   Production server build and start scripts
public/                    Runtime models, textures, logos, icons, and minimap
index.html                 Small standalone harbor sandbox
package.json               Development and production commands
vite.config.ts             Vite plugins and server-only environment wiring
.env.example               Safe environment template with no credentials
```

## Data and security notes

- API keys belong in the server environment only.
- `.env`, local data directories, server secrets, logs, captures, generated media, and build output are ignored by Git.
- Nansen data is used as read-only evidence for the game simulation. Tideflow does not submit trades or onchain transactions.
- The default persistence adapter is a single-process JSON store. It is suitable for a demo and a single server instance, not a multi-region multiplayer backend.
- A browser session stores a profile and a server session cookie; the server validates actions again before changing inventory, equipment, capacity, or NS.

## Status

Tideflow is a playable hackathon build with a complete loading-to-operations loop, Nansen-backed arrival input, automatic vessel handling, per-harbor equipment assignment, container transfer, record replay, and a shared shop. The live feed remains dependent on the configured Nansen account, endpoint availability, and request budget. When those conditions are not met, the UI reports the feed state instead of fabricating activity.

