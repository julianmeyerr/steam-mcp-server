import assert from "node:assert/strict";
import test from "node:test";
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
    version: "1.1.0",
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
