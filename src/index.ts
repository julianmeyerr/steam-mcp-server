#!/usr/bin/env node
import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerSteamTools } from "./tools.js";

async function main() {
  if (!process.env.STEAM_API_KEY) {
    console.error(
      "ERROR: falta la variable de entorno STEAM_API_KEY. Definila en tu archivo .env " +
        "(podés generar una key en https://steamcommunity.com/dev/apikey)."
    );
    process.exit(1);
  }

  // Validación opcional pero recomendada para personalización
  if (!process.env.MY_STEAM_ID) {
    console.warn(
      "ADVERTENCIA: No configuraste MY_STEAM_ID en tu archivo .env. " +
        "Las funciones personalizadas requerirán que pases tu steamid manualmente."
    );
  }

  if (process.env.STEAM_FAMILY_MEMBER_IDS) {
    console.error("Biblioteca familiar configurada con STEAM_FAMILY_MEMBER_IDS");
  }

  const server = new McpServer({
    name: "steam-mcp-server",
    version: "1.1.3",
  });

  registerSteamTools(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("steam-mcp-server corriendo via stdio");
}

main().catch((error) => {
  console.error("Error fatal del servidor:", error);
  process.exit(1);
});
