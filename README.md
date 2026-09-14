# steam-mcp-server

MCP server that exposes the [Steam Web API](https://developer.valvesoftware.com/wiki/Steam_Web_API) as tools for Claude Desktop or Claude Code, running locally over stdio.

## Available tools

| Tool | Description |
|---|---|
| `get_player_profile` | Public profile for one or more users (name, avatar, status) |
| `get_owned_games` | Games owned by a user, including playtime |
| `get_family_owned_games` | Unified family game library with ownership information |
| `get_recently_played_games` | Games played within the last two weeks |
| `get_player_achievements` | A user's achievements for a specific game |
| `get_friend_list` | A user's Steam friend list |
| `get_friends_current_status` | Current status and games being played by your friends |
| `get_friends_recent_activity` | Recent activity from your friends |
| `compare_owned_games` | Games owned in common with another user |
| `get_app_news` | Latest news and updates for a Steam game |
| `get_global_achievement_percentages` | Percentage of players who unlocked each achievement |
| `get_current_players` | Current player count for a game |
| `resolve_vanity_url` | Converts a vanity URL to a SteamID64 |
| `search_game` | Searches for a game and returns its AppID |
| `get_player_bans` | VAC, community, economy, and game ban status |

The Steam profile being queried must be public, except when querying your own SteamID with your own API key.
An API key is required for account-related tools; public tools such as current player counts and game search can run without one.

## 1. Get a Steam API key

Go to https://steamcommunity.com/dev/apikey, sign in with your Steam account, and generate an API key. Steam requires at least one game in your library to issue a key.

## 2. Installation

Requirements: Node.js 18 or later.

```bash
npm install
cp .env.example .env       # macOS/Linux
# Windows PowerShell: Copy-Item .env.example .env
# Edit .env and add your STEAM_API_KEY
npm run build
```

The `.env` file contains secrets and must not be published. If your network uses SSL inspection, set `STEAM_EXTRA_CA` to the path of your private CA certificate. Use `STEAM_TLS_INSECURE=1` only as a last resort on a trusted network.

Steam responses are cached in memory for 30 seconds by default, and requests are spaced by at least 100 milliseconds to reduce rate-limit errors. Configure `STEAM_CACHE_TTL_MS=0` to disable caching or adjust `STEAM_MIN_REQUEST_INTERVAL_MS` if needed.

### Family library

Configure the SteamID64 values of family members as a comma-separated list. `MY_STEAM_ID` is included automatically:

```env
MY_STEAM_ID=76561199080486814
STEAM_FAMILY_MEMBER_IDS=76561100000000001,76561100000000002
```

The `get_family_owned_games` tool returns each game's `appid`, name, and owner's SteamID64. If a game appears in multiple accounts, `owner` contains multiple IDs. The Steam Web API does not directly expose games borrowed exclusively through Steam Families; it only returns games that each account exposes as owned.

## 3. Test with MCP Inspector

This is recommended before connecting the server to a real client.

```bash
npm run inspector
```

This opens a browser UI where you can list and execute the tools manually to verify that they respond correctly.

To test the published npm package instead of the local build:

```powershell
npx --yes "@modelcontextprotocol/inspector" npx --yes --package "@j.meyer/steam-mcp-server@1.1.6" steam-mcp-server
```

## 4. Connect to Claude Desktop

Edit the Claude Desktop configuration file:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json`

Add the server using the absolute path to your project:

```json
{
  "mcpServers": {
    "steam": {
      "command": "npx",
      "args": [
        "--yes",
        "--package",
        "@j.meyer/steam-mcp-server@1.1.6",
        "steam-mcp-server"
      ],
      "env": {
        "STEAM_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

Restart Claude Desktop. The `steam` server should appear in the tools menu.

## 5. Connect to Claude Code

```bash
claude mcp add steam -- npx --yes --package @j.meyer/steam-mcp-server@1.1.6 steam-mcp-server
```

Claude Code inherits `STEAM_API_KEY` if it is defined in your `.env` file or in the shell environment where you run `claude`.

## Publishing the project

This server is designed to run locally over `stdio`. Each user must configure their own `STEAM_API_KEY` and `MY_STEAM_ID`. Never copy your `.env` file or include an API key in the published configuration.

Before creating a release, verify the installation from a clean copy:

```bash
npm ci
npm run build
npm test
npm run inspector
```

If you publish it as an npm package, `npm publish` builds the project automatically and only distributes `dist`, `README.md`, `.env.example`, and `LICENSE`.
The package is available as `@j.meyer/steam-mcp-server`.

### Automated releases

Pushing a tag matching `vX.Y.Z` runs `.github/workflows/publish.yml`. The workflow verifies that the tag matches the versions in `package.json` and `server.json`, runs the build, tests, audit, and package verification, then publishes to npm, the official MCP Registry, and GitHub Releases.

The workflow uses npm Trusted Publishing with GitHub OIDC, so no `NPM_TOKEN` secret is required. Before the first automated release, configure a Trusted Publisher in the npm package settings with:

- Provider: GitHub Actions
- User: `julianmeyerr`
- Repository: `steam-mcp-server`
- Workflow: `publish.yml`
- Allowed action: `npm publish`

The MCP Registry publication uses GitHub OIDC as well and requires no additional secret. The registry metadata is defined in `server.json` and ownership is verified through `mcpName` in `package.json`.

After merging the version bump into `main`, push its matching tag:

```bash
git push origin v1.1.6
```

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.

## How to get a SteamID64

Most tools expect a 64-bit `steamid` (for example, `76561197960435530`) rather than a username. You can use the `resolve_vanity_url` tool to convert a custom Steam URL, or use an external service such as SteamID.io.

## Possible next steps

- Add more Steam Store tools, such as reviews, prices, and game details.
