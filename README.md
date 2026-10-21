# ☢️ Politics & War Nuke Target Finder Discord Bot

A standalone, high-performance Discord bot for Politics & War designed specifically to evaluate high-infrastructure nuclear strike targets and manage local server coalitions.

Built with **Node.js**, **Discord.js v14**, local **JSON caching** for raw Politics & War nation snapshots, and a lightweight **SQLite** database (`better-sqlite3`) strictly for local server coalitions. Requires **zero external database services** (no MongoDB, no Redis, no sharding).

---

## 🚀 Key Features

1. **`/target-finder nuke`**:
   - Evaluates and ranks hostile nations and cities for maximum nuclear damage and rebuild dollar loss.
   - Computes expected infrastructure destruction using exact Politics & War truncated uniform distribution mechanics.
   - Calculates convex dollar rebuild replacement cost destroyed (destroying high infra yields massive monetary losses).
   - Interactive pagination (`⏪`, `◀️`, `▶️`, `⏩`) with radioactive green visual theme (`#39FF14`).
   - Rich filters: score bounds, automated 0.75x–2.5x attacker war ranges, open defensive wars slot filter (< 3 wars), beige protection filter, applicants filter, and Guiding Satellite (+20% damage) toggle.
   - Supports filtering by saved coalition names or raw comma-separated alliance IDs.

2. **`/coalition` (Admin Only)**:
   - Save, list, update, and delete local coalitions directly in SQLite.
   - Scoped per Discord server (`guild_id`).
   - Subcommands: `add`, `list`, `update`, `delete`.
   - Requires Administrator permissions.

3. **Background Periodic GraphQL Fetcher with Page-Level Resume**:
   - Sweeps Politics & War GraphQL API page-by-page.
   - Collects military (aircraft, ships, nukes, spies, missiles), score, defensive wars, and city infrastructure/land.
   - **Split-Cache Architecture**:
     - `nations_current.json`: Tracks active sweep progress page-by-page. If the bot restarts or is interrupted, it resumes from the exact page it left off.
     - `nations_backup.json`: Contains the full completed run snapshot so commands always serve a complete dataset.
   - **Corruption Auto-Quarantine & Self-Healing**: Corrupt or truncated files are automatically quarantined (`.corrupted.<timestamp>`) and self-healed from `.bak` backup files.
   - **SQLite Auto-Repair**: Runs `PRAGMA integrity_check` on boot, auto-quarantines damaged databases, and restores from `nukebot.db.bak`.

---

## 📁 Project Structure

```
NukeBot/
├── .env.example               # Template configuration file
├── .gitignore                 # Ignores node_modules, .env, SQLite, and JSON data
├── README.md                  # Comprehensive setup and user guide
├── package.json               # Node.js dependencies and run scripts
├── index.js                   # Application entry point, crash shield, & event router
├── data/
│   ├── nukebot.db             # SQLite database strictly for server coalitions
│   ├── nukebot.db.bak         # Synchronous SQLite hot backup
│   ├── nations_current.json   # In-progress sweep with page-level resume state
│   └── nations_backup.json    # Complete full run snapshot
└── src/
    ├── config.js              # Environment variable validation and constants
    ├── database.js            # SQLite database with integrity check & auto-repair
    ├── nationsCache.js        # Split cache (current + backup) with self-healing
    ├── fetcher.js             # P&W periodic fetcher with page-level resume
    ├── logic/
    │   └── weaponDamageCalc.js # P&W damage distribution and infra cost table
    └── commands/
        ├── targetFinder.js    # /target-finder nuke slash command & paginator
        └── coalition.js       # /coalition add/delete/update/list management
```

---

## 🛠️ Prerequisites

- **Node.js**: v18.0.0 or higher (v20+ / v22+ recommended)
- **npm**: v9.0.0 or higher
- A **Politics & War API Key** (from an active in-game account)
- A **Discord Bot Token** and **Client ID** (from the Discord Developer Portal)

---

## 📋 Step-by-Step Setup Guide

### 1. Create a Discord Bot & Obtain Credentials

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications).
2. Click **New Application** in the top right, name your bot (e.g., `Nuke Target Finder`), and click **Create**.
3. In the left sidebar, navigate to **General Information**:
   - Copy the **Application ID** (this is your `CLIENT_ID`).
4. In the left sidebar, navigate to **Bot**:
   - Click **Reset Token** to generate a new bot token, then copy it (this is your `DISCORD_TOKEN`).
5. Invite the bot to your Discord server:
   - Navigate to **OAuth2 > URL Generator**.
   - Under **Scopes**, select:
     - `bot`
     - `applications.commands`
   - Under **Bot Permissions**, select:
     - `Send Messages`
     - `Embed Links`
     - `Attach Files`
     - `Read Message History`
     - `Use Slash Commands`
   - Copy the generated URL at the bottom, paste it into your browser, and authorize it for your server.

---

### 2. Obtain Your Politics & War API Key

1. Log into your [Politics & War](https://politicsandwar.com/) account.
2. Click on **Account** (or go to `https://politicsandwar.com/account/`).
3. Scroll down to the **API Key** section.
4. If you don't already have one, generate a key. Copy your key (this is your `PNW_API_KEY`).

---

### 3. Clone / Extract and Install Dependencies

Open a terminal in the `NukeBot` project directory:

```bash
cd NukeBot
npm install
```

---

### 4. Configure Environment Variables

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Open `.env` in any text editor and fill in your keys:

```env
# Discord Credentials
DISCORD_TOKEN=your_bot_token_here
CLIENT_ID=your_discord_application_id_here

# Optional: Add your server/guild ID for instant slash command registration during development
# If left blank, commands will be registered globally (takes a few minutes to populate across Discord)
GUILD_ID=

# Politics & War GraphQL API
PNW_API_KEY=your_pnw_api_key_here

# Fetcher Sweep Interval in minutes (default: 15)
FETCH_INTERVAL_MINUTES=15

# Delay between page requests during data sweep in milliseconds (default: 600)
PAGE_DELAY_MS=600

# SQLite Database path (default: ./data/nukebot.db)
DATABASE_PATH=./data/nukebot.db
```

---

### 5. Start the Bot

#### Normal Execution
```bash
npm start
```

#### Development Mode (Auto-reloads on file changes)
```bash
npm run dev
```

#### Production Deployment with PM2 (Recommended)
To keep the bot running 24/7 in the background with auto-restart on system reboot:

```bash
# Install PM2 globally if not installed
npm install -g pm2

# Start the bot under PM2
pm2 start index.js --name nukebot

# View live logs
pm2 logs nukebot

# Configure PM2 to start on system boot
pm2 startup
pm2 save
```

---

## 🎮 Slash Command Reference

### 1. `/coalition` (Administrator Only)

Store and manage server-specific coalitions mapped to alliance IDs.

| Subcommand | Option | Description |
|---|---|---|
| `/coalition add` | `name` (required)<br>`alliance_ids` (required) | Creates a coalition. Example: `/coalition add name:enemies alliance_ids:1234, 5678, 9012` |
| `/coalition list` | *None* | Lists all registered coalitions for the current server. |
| `/coalition update` | `name` (required)<br>`alliance_ids` (required) | Updates the alliance IDs of an existing coalition. |
| `/coalition delete` | `name` (required) | Removes a coalition from this server. |

---

### 2. `/target-finder nuke`

Discovers and ranks prime nuclear strike targets.

| Option | Type | Default | Description |
|---|---|---|---|
| `cities` | Integer | `3` | Top N cities evaluated per nation (1–10). |
| `sort_by` | Choice | `damage_value` | Ranking criteria: `Rebuild Value Destroyed ($)`, `Raw Infra Destroyed`, or `Total Infra Value`. |
| `coalition_or_alliance` | String | *None* | Saved coalition name (e.g. `enemies`) OR comma-separated alliance IDs (e.g. `123, 456`). |
| `manual_score` | Integer | *None* | Attacker score. Automatically sets valid attack range to `[0.75x, 2.5x]`. |
| `min_score` | Integer | *None* | Explicit minimum target nation score. |
| `max_score` | Integer | *None* | Explicit maximum target nation score. |
| `has_open_defensives` | Boolean | `true` | Restricts targets to those with open defensive war slots (< 3 defensive wars). |
| `include_beige` | Boolean | `false` | Include nations with active beige turns. |
| `include_applicants` | Boolean | `false` | Include alliance applicants. |
| `guiding_satellite` | Boolean | `false` | Adds Guiding Satellite project multiplier (+20% infra damage). |

---

## 📐 Mechanics & Formulas

- **Nuke Damage**: Evaluates truncated uniform distribution $R \sim \text{Uniform}(A, B)$ where:
  - $A = 1,700$
  - $B = \max(2,000, \text{DisplayPopDensity} \times 13.5)$
  - City Infra Upper Cap = $\min((\text{infra} \times 0.8) + 150, \text{infra})$
  - Guiding Satellite Multiplier: $\times 1.2$ when enabled.
- **Precomputed Cumulative Infra Replacement Cost**:
  - Unit price curve: $\text{price} = \frac{(\text{infra} - 10)^{2.2}}{710} + 300$
  - Precomputed in a high-speed `Float64Array` lookup table for instant sub-millisecond evaluation.
- **Rebuild Dollar Loss**:
  $$\text{Damage Value} = \text{calculateInfraCost}(\text{currentInfra}) - \text{calculateInfraCost}(\text{currentInfra} - \text{damageDestroyed})$$

---

## 📄 License & Ownership

**Proprietary Software** — Custom built exclusively for **sneb_8777**. All rights reserved. Unauthorized copying, distribution, re-licensing, or public publication is strictly prohibited.
