import assert from "node:assert/strict";
import test from "node:test";
import axios from "axios";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerSteamTools } from "../src/tools.js";

const expectedToolNames = [
  "get_player_profile",
  "get_owned_games",
  "get_family_owned_games",
  "get_recently_played_games",
  "get_player_achievements",
  "get_friend_list",
  "get_friends_current_status",
  "get_friends_recent_activity",
  "compare_owned_games",
  "get_app_news",
  "get_global_achievement_percentages",
  "get_current_players",
  "resolve_vanity_url",
  "search_game",
  "get_player_bans",
];

async function createConnectedPair() {
  const server = new McpServer({
    name: "steam-mcp-server",
    version: "1.1.6",
  });
  registerSteamTools(server);

  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return { client, server };
}

test("registers all Steam tools", async (t) => {
  const { client, server } = await createConnectedPair();
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const result = await client.listTools();
  const toolNames = result.tools.map((tool) => tool.name);

  assert.deepEqual(toolNames, expectedToolNames);
});

test("returns a useful error when the Steam API key is missing", async (t) => {
  const previousApiKey = process.env.STEAM_API_KEY;
  delete process.env.STEAM_API_KEY;

  const { client, server } = await createConnectedPair();
  t.after(async () => {
    if (previousApiKey === undefined) {
      delete process.env.STEAM_API_KEY;
    } else {
      process.env.STEAM_API_KEY = previousApiKey;
    }
    await client.close();
    await server.close();
  });

  const result = await client.callTool({
    name: "get_player_profile",
    arguments: { steamids: ["76561197960435530"] },
  });

  assert.equal(result.isError, true);
  assert.match(
    String(result.content?.[0]?.type === "text" ? result.content[0].text : ""),
    /STEAM_API_KEY/
  );
});

test("allows public player counts without an API key and caches repeated requests", async (t) => {
  const previousApiKey = process.env.STEAM_API_KEY;
  const previousGet = axios.get;
  let requestCount = 0;
  delete process.env.STEAM_API_KEY;

  axios.get = ((url: string, config?: { params?: Record<string, unknown> }) => {
    requestCount += 1;
    assert.equal(
      url,
      "https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1"
    );
    assert.deepEqual(config?.params, { format: "json", appid: 730 });
    return Promise.resolve({
      data: { response: { result: 1, player_count: 42 } },
    });
  }) as typeof axios.get;

  const { client, server } = await createConnectedPair();
  t.after(async () => {
    axios.get = previousGet;
    if (previousApiKey === undefined) {
      delete process.env.STEAM_API_KEY;
    } else {
      process.env.STEAM_API_KEY = previousApiKey;
    }
    await client.close();
    await server.close();
  });

  const firstResult = await client.callTool({
    name: "get_current_players",
    arguments: { appid: 730 },
  });
  const secondResult = await client.callTool({
    name: "get_current_players",
    arguments: { appid: 730 },
  });

  assert.notEqual(firstResult.isError, true);
  assert.notEqual(secondResult.isError, true);
  assert.match(
    String(firstResult.content?.[0]?.type === "text" ? firstResult.content[0].text : ""),
    /player_count/
  );
  assert.equal(requestCount, 1);
});

test("maps authenticated game responses into hours", async (t) => {
  const previousApiKey = process.env.STEAM_API_KEY;
  const previousGet = axios.get;
  process.env.STEAM_API_KEY = "test-key";

  axios.get = ((url: string, config?: { params?: Record<string, unknown> }) => {
    assert.equal(
      url,
      "https://api.steampowered.com/IPlayerService/GetOwnedGames/v0001"
    );
    assert.equal(config?.params?.key, "test-key");
    return Promise.resolve({
      data: {
        response: {
          game_count: 1,
          games: [
            {
              appid: 730,
              name: "Counter-Strike 2",
              playtime_forever: 125,
              playtime_2weeks: 65,
            },
          ],
        },
      },
    });
  }) as typeof axios.get;

  const { client, server } = await createConnectedPair();
  t.after(async () => {
    axios.get = previousGet;
    if (previousApiKey === undefined) {
      delete process.env.STEAM_API_KEY;
    } else {
      process.env.STEAM_API_KEY = previousApiKey;
    }
    await client.close();
    await server.close();
  });

  const result = await client.callTool({
    name: "get_owned_games",
    arguments: {
      steamid: "76561197960435530",
      include_appinfo: true,
      include_played_free_games: true,
    },
  });
  const text = String(result.content?.[0]?.type === "text" ? result.content[0].text : "");

  assert.notEqual(result.isError, true);
  assert.match(text, /"playtime_hours": 2\.1/);
  assert.match(text, /"playtime_2weeks_hours": 1\.1/);
});
