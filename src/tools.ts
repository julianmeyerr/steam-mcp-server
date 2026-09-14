import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { steamPublicRequest, steamRequest, steamStoreRequest } from "./steam-client.js";

/** Convierte el resultado de una tool en el formato que espera el SDK de MCP. */
function textResult(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof data === "string" ? data : JSON.stringify(data, null, 2),
      },
    ],
  };
}

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

/** Steam devuelve los tiempos en MINUTOS. Convertimos a HORAS (1 decimal). */
function minutesToHours(minutes?: number): number | undefined {
  if (minutes === undefined || minutes === null) return undefined;
  return Math.round((minutes / 60) * 10) / 10;
}

/** Helper para obtener el ID del dueño si no se especifica uno en la query */
function getEffectiveSteamId(providedId?: string): string {
  const id = providedId || process.env.MY_STEAM_ID;
  if (!id) {
    throw new Error(
      "No se proporcionó un steamid y la variable MY_STEAM_ID no está configurada en el .env"
    );
  }
  return id;
}

/** Obtiene el dueño y los miembros configurados para consultar la familia. */
function getFamilySteamIds(): string[] {
  const ids = [
    process.env.MY_STEAM_ID,
    ...(process.env.STEAM_FAMILY_MEMBER_IDS ?? '').split(/[\s,;]+/),
  ]
    .map((id) => id?.trim())
    .filter((id): id is string => Boolean(id));

  const invalidId = ids.find((id) => !/^\d{17}$/.test(id));
  if (invalidId) {
    throw new Error(
      `SteamID64 inválido en MY_STEAM_ID o STEAM_FAMILY_MEMBER_IDS: ${invalidId}`
    );
  }

  return [...new Set(ids)];
}

export function registerSteamTools(server: McpServer) {
  // 1. Perfil de jugador(es) (Si se deja vacío, trae el tuyo)
  server.registerTool(
    "get_player_profile",
    {
      title: "Perfil de jugador de Steam",
      description:
        "Devuelve el perfil público de uno o varios usuarios. Si la lista está vacía, devuelve tu propio perfil.",
      inputSchema: {
        steamids: z
          .array(z.string())
          .max(100)
          .optional()
          .describe("Lista opcional de SteamID64. Si se omite, usa tu propio ID."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ steamids }) => {
      try {
        const ids = steamids && steamids.length > 0 ? steamids : [getEffectiveSteamId()];
        const data = await steamRequest<{
          response: { players: Record<string, unknown>[] };
        }>("ISteamUser/GetPlayerSummaries/v0002", {
          steamids: ids.join(","),
        });
        const players = data.response.players;
        if (!players.length) {
          return textResult("No se encontró ningún perfil para esos steamids.");
        }
        return textResult(players);
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    }
  );

  // 2. Juegos en biblioteca (Tu biblioteca por defecto)
  server.registerTool(
    "get_owned_games",
    {
      title: "Juegos que posee un usuario",
      description:
        "Lista los juegos que un usuario posee en Steam. Si se omite el ID, lista tus propios juegos.",
      inputSchema: {
        steamid: z.string().optional().describe("SteamID64 del usuario (opcional, por defecto el tuyo)"),
        include_appinfo: z.boolean().default(true).describe("Incluir nombre e ícono de cada juego"),
        include_played_free_games: z.boolean().default(true).describe("Incluir juegos free-to-play"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ steamid, include_appinfo, include_played_free_games }) => {
      try {
        const targetId = getEffectiveSteamId(steamid);
        const data = await steamRequest<{
          response: {
            game_count?: number;
            games?: {
              appid: number;
              name?: string;
              playtime_forever?: number;
              playtime_2weeks?: number;
            }[];
          };
        }>("IPlayerService/GetOwnedGames/v0001", {
          steamid: targetId,
          include_appinfo,
          include_played_free_games,
        });
        if (!data.response.games) {
          return textResult("El perfil es privado o no devolvió juegos. Verificá la privacidad.");
        }
        const games = data.response.games.map((g) => ({
          appid: g.appid,
          name: g.name,
          playtime_hours: minutesToHours(g.playtime_forever),
          playtime_2weeks_hours: minutesToHours(g.playtime_2weeks),
        }));
        return textResult({
          game_count: data.response.game_count,
          games,
        });
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    }
  );

  // 3. Biblioteca familiar unificada
  server.registerTool(
    "get_family_owned_games",
    {
      title: "Biblioteca familiar unificada",
      description:
        "Devuelve una lista unificada de juegos de MY_STEAM_ID y los miembros configurados en STEAM_FAMILY_MEMBER_IDS, indicando sus dueños.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        const memberIds = getFamilySteamIds();
        const libraries = await Promise.all(
          memberIds.map(async (steamid) => {
            const data = await steamRequest<{
              response: {
                games?: { appid: number; name?: string }[];
              };
            }>("IPlayerService/GetOwnedGames/v0001", {
              steamid,
              include_appinfo: true,
              include_played_free_games: true,
            });
            return { steamid, games: data.response.games ?? [] };
          })
        );

        const gamesByAppId = new Map<
          number,
          { name: string; owners: Set<string> }
        >();

        for (const { steamid, games } of libraries) {
          for (const game of games) {
            if (!game.name) continue;
            const existing = gamesByAppId.get(game.appid);
            if (existing) {
              existing.owners.add(steamid);
            } else {
              gamesByAppId.set(game.appid, {
                name: game.name,
                owners: new Set([steamid]),
              });
            }
          }
        }

        return textResult(
          [...gamesByAppId.entries()].map(([appid, { name, owners }]) => {
            const ownerIds = [...owners];
            return {
              appid,
              name,
              owner: ownerIds.length === 1 ? ownerIds[0] : ownerIds,
            };
          })
        );
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    }
  );

  // 4. Juegos jugados recientemente
  server.registerTool(
    "get_recently_played_games",
    {
      title: "Juegos jugados recientemente",
      description: "Lista los juegos jugados en las últimas 2 semanas. Por defecto usa tu ID.",
      inputSchema: {
        steamid: z.string().optional().describe("SteamID64 del usuario (opcional)"),
        count: z.number().int().min(1).optional().describe("Límite opcional de juegos"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ steamid, count }) => {
      try {
        const targetId = getEffectiveSteamId(steamid);
        const data = await steamRequest<{
          response: { total_count?: number; games?: Record<string, unknown>[] };
        }>("IPlayerService/GetRecentlyPlayedGames/v0001", { steamid: targetId, count });
        return textResult(data.response);
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    }
  );

  // 4. Logros de un usuario en un juego
  server.registerTool(
    "get_player_achievements",
    {
      title: "Logros de un usuario en un juego",
      description: "Devuelve los logros de un usuario (o los tuyos por defecto) para un juego.",
      inputSchema: {
        appid: z.number().int().describe("AppID del juego (ej: 730)"),
        steamid: z.string().optional().describe("SteamID64 del usuario (opcional)"),
        language: z.string().optional().describe("Idioma (ej: 'spanish')"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ steamid, appid, language }) => {
      try {
        const targetId = getEffectiveSteamId(steamid);
        const data = await steamRequest<{
          playerstats: { success: boolean; error?: string; achievements?: Record<string, unknown>[] };
        }>("ISteamUserStats/GetPlayerAchievements/v0001", {
          steamid: targetId,
          appid,
          l: language,
        });
        if (!data.playerstats.success) {
          return errorResult(`No se pudieron obtener logros: ${data.playerstats.error ?? "perfil privado o juego sin logros."}`);
        }
        return textResult(data.playerstats.achievements ?? []);
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    }
  );

  // 5. Lista de amigos
  server.registerTool(
    "get_friend_list",
    {
      title: "Lista de amigos de un usuario",
      description: "Devuelve tus amigos de Steam (o los de un ID específico).",
      inputSchema: {
        steamid: z.string().optional().describe("SteamID64 (opcional, por defecto el tuyo)"),
        relationship: z.enum(["all", "friend"]).default("friend").describe("Filtro"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ steamid, relationship }) => {
      try {
        const targetId = getEffectiveSteamId(steamid);
        const data = await steamRequest<{
          friendslist?: { friends: Record<string, unknown>[] };
        }>("ISteamUser/GetFriendList/v0001", { steamid: targetId, relationship });
        if (!data.friendslist) {
          return textResult("El perfil es privado, no se puede ver la lista de amigos.");
        }
        return textResult(data.friendslist.friends);
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    }
  );

  // =========================================================================
  // HERRAMIENTAS NUEVAS Y PERSONALIZADAS (AGREGADORES)
  // =========================================================================

  // 6. ¿Qué están jugando mis amigos AHORA MISMO y qué es lo más popular?
  server.registerTool(
    "get_friends_current_status",
    {
      title: "Estado y juegos actuales de mis amigos",
      description: "Obtiene en tiempo real qué amigos están online y qué juego específico están jugando en este instante.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        const myId = getEffectiveSteamId();
        const friendsData = await steamRequest<{
          friendslist?: { friends: { steamid: string }[] };
        }>("ISteamUser/GetFriendList/v0001", { steamid: myId, relationship: "friend" });

        if (!friendsData.friendslist || !friendsData.friendslist.friends.length) {
          return textResult("No se encontraron amigos o tu lista de amigos es privada.");
        }

        const friendIds = friendsData.friendslist.friends.map((f) => f.steamid);

        // Steam permite consultar resúmenes en bloques de hasta 100 IDs
        const chunks = [];
        for (let i = 0; i < friendIds.length; i += 100) {
          chunks.push(friendIds.slice(i, i + 100));
        }

        const allFriendsStatus: Record<string, unknown>[] = [];
        for (const chunk of chunks) {
          const data = await steamRequest<{
            response: { players: Record<string, unknown>[] };
          }>("ISteamUser/GetPlayerSummaries/v0002", {
            steamids: chunk.join(","),
          });
          if (data.response?.players) {
            allFriendsStatus.push(...data.response.players);
          }
        }

        return textResult(allFriendsStatus);
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    }
  );

  // 7. ¿Qué juegos han jugado últimamente mis amigos (Últimas 2 semanas)?
  server.registerTool(
    "get_friends_recent_activity",
    {
      title: "Juegos jugados recientemente por mis amigos",
      description: "Escanea la actividad de tus amigos más activos en las últimas 2 semanas para saber qué se está jugando.",
      inputSchema: {
        limit: z.number().int().min(1).max(20).default(5).describe("Cantidad máxima de amigos activos a analizar para evitar saturar la API."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ limit }) => {
      try {
        const myId = getEffectiveSteamId();
        const friendsData = await steamRequest<{
          friendslist?: { friends: { steamid: string }[] };
        }>("ISteamUser/GetFriendList/v0001", { steamid: myId, relationship: "friend" });

        if (!friendsData.friendslist || !friendsData.friendslist.friends.length) {
          return textResult("No se encontraron amigos o tu lista es privada.");
        }

        const friendIds = friendsData.friendslist.friends.map((f) => f.steamid);

        // Buscamos los estados de todos para ver quiénes jugaron o se conectaron hace poco
        const summariesData = await steamRequest<{
          response: { players: { steamid: string; personaname: string; personastate: number; lastlogoff?: number; gameextrainfo?: string }[] };
        }>("ISteamUser/GetPlayerSummaries/v0002", { steamids: friendIds.slice(0, 100).join(",") });

        const players = summariesData.response.players || [];

        // Filtramos y priorizamos: Amigos jugando ahora -> Online -> Desconectados recientemente
        const activePlayers = players
          .sort((a, b) => {
            if (a.gameextrainfo && !b.gameextrainfo) return -1;
            if (!a.gameextrainfo && b.gameextrainfo) return 1;
            if (a.personastate > 0 && b.personastate === 0) return -1;
            if (a.personastate === 0 && b.personastate > 0) return 1;
            return (b.lastlogoff || 0) - (a.lastlogoff || 0);
          })
          .slice(0, limit);

        const activityLog: Record<string, unknown>[] = [];

        // Consultas en paralelo controladas para el subconjunto de amigos activos
        await Promise.all(
          activePlayers.map(async (player) => {
            try {
              const recentGames = await steamRequest<{
                response: { games?: Record<string, unknown>[] };
              }>("IPlayerService/GetRecentlyPlayedGames/v0001", { steamid: player.steamid, count: 3 });

              if (recentGames.response?.games && recentGames.response.games.length > 0) {
                activityLog.push({
                  friend_name: player.personaname,
                  steamid: player.steamid,
                  currently_playing: player.gameextrainfo || "Inactivo",
                  recent_games: recentGames.response.games,
                });
              }
            } catch {
              // Si el perfil de un amigo en particular es privado, fallará en silencio para él
            }
          })
        );

        return textResult(activityLog);
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    }
  );

  // 8. ¿Qué juegos en común tengo con X amigo?
  server.registerTool(
    "compare_owned_games",
    {
      title: "Comparar juegos en común con un amigo",
      description: "Cruza tu biblioteca con la de otro usuario para saber qué juegos comparten y cuántas horas tiene cada uno.",
      inputSchema: {
        friend_steamid: z.string().describe("El SteamID64 del amigo con el que te quieres comparar."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ friend_steamid }) => {
      try {
        const myId = getEffectiveSteamId();

        // Pedir tus juegos
        const myGamesData = await steamRequest<{
          response: { games?: { appid: number; name: string; playtime_forever: number }[] };
        }>("IPlayerService/GetOwnedGames/v0001", { steamid: myId, include_appinfo: true, include_played_free_games: true });

        // Pedir juegos del amigo
        const friendGamesData = await steamRequest<{
          response: { games?: { appid: number; name: string; playtime_forever: number }[] };
        }>("IPlayerService/GetOwnedGames/v0001", { steamid: friend_steamid, include_appinfo: true, include_played_free_games: true });

        const myGames = myGamesData.response.games || [];
        const friendGames = friendGamesData.response.games || [];

        if (!myGames.length) return textResult("Tu biblioteca está vacía o es privada.");
        if (!friendGames.length) return textResult("La biblioteca de tu amigo está vacía o es privada.");

        // Mapear los juegos del amigo para buscarlos de forma instantánea O(1)
        const friendGamesMap = new Map(friendGames.map((g) => [g.appid, g]));

        const commonGames = myGames
          .filter((g) => friendGamesMap.has(g.appid))
          .map((g) => {
            const fGame = friendGamesMap.get(g.appid);
            return {
              appid: g.appid,
              game_name: g.name,
              my_playtime_hours: minutesToHours(g.playtime_forever),
              friend_playtime_hours: minutesToHours(fGame?.playtime_forever),
            };
          });

        return textResult({
          total_in_common: commonGames.length,
          games: commonGames,
        });
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    }
  );

  // 9. Noticias (Igual que antes)
  server.registerTool(
    "get_app_news",
    {
      title: "Noticias de un juego",
      description: "Devuelve las últimas noticias/actualizaciones publicadas para un juego de Steam.",
      inputSchema: {
        appid: z.number().int().describe("AppID del juego"),
        count: z.number().int().min(1).max(50).default(5).describe("Cantidad de noticias"),
        maxlength: z.number().int().min(0).default(300).describe("Largo máximo del contenido"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ appid, count, maxlength }) => {
      try {
        const data = await steamRequest<{
          appnews: { appid: number; newsitems: Record<string, unknown>[] };
        }>("ISteamNews/GetNewsForApp/v0002", { appid, count, maxlength });
        return textResult(data.appnews.newsitems);
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    }
  );

  // 10. Porcentajes globales de logros (Igual que antes)
  server.registerTool(
    "get_global_achievement_percentages",
    {
      title: "Porcentaje global de logros de un juego",
      description: "Devuelve el porcentaje de todos los jugadores de Steam que desbloquearon cada logro.",
      inputSchema: { appid: z.number().int().describe("AppID del juego") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ appid }) => {
      try {
        const data = await steamRequest<{
          achievementpercentages: { achievements: Record<string, unknown>[] };
        }>("ISteamUserStats/GetGlobalAchievementPercentagesForApp/v0002", { gameid: appid });
        return textResult(data.achievementpercentages.achievements);
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    }
  );

  // 11. Jugadores actuales de un juego (no requiere API key)
  server.registerTool(
    "get_current_players",
    {
      title: "Jugadores conectados ahora",
      description: "Devuelve la cantidad total de jugadores activos en un juego en este momento en Steam.",
      inputSchema: { appid: z.number().int().describe("AppID del juego") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ appid }) => {
      try {
        const data = await steamPublicRequest<{
          response: { result: number; player_count: number };
        }>("ISteamUserStats/GetNumberOfCurrentPlayers/v1", { appid });
        if (data.response.result !== 1) {
          return errorResult("No se pudo obtener el conteo de jugadores para ese appid.");
        }
        return textResult({ appid, player_count: data.response.player_count });
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    }
  );

  // 12. Resolver vanity URL a SteamID64
  server.registerTool(
    "resolve_vanity_url",
    {
      title: "Resolver vanity URL de Steam",
      description:
        "Convierte una URL personalizada (ej: 'miusuario' de steamcommunity.com/id/miusuario) a un SteamID64.",
      inputSchema: {
        vanityurl: z.string().describe("Fragmento de la vanity URL (sin la URL completa)"),
        url_type: z.enum(["1", "2", "3"]).default("1").describe(
          "1: perfil individual, 2: grupo, 3: grupo de juego oficial"
        ),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ vanityurl, url_type }) => {
      try {
        const data = await steamRequest<{
          response: { success: number; steamid?: string; message?: string };
        }>("ISteamUser/ResolveVanityURL/v1", { vanityurl, url_type });
        if (data.response.success !== 1 || !data.response.steamid) {
          return errorResult(`No se encontró un SteamID para '${vanityurl}'. ${data.response.message ?? ""}`.trim());
        }
        return textResult({ vanityurl, steamid: data.response.steamid });
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    }
  );

  // 13. Buscar juego por nombre -> appid (usa la API de la tienda)
  server.registerTool(
    "search_game",
    {
      title: "Buscar juego por nombre",
      description:
        "Busca juegos en Steam por término y devuelve coincidencias con su appid. Útil para obtener el appid a partir del nombre.",
      inputSchema: {
        term: z.string().describe("Término de búsqueda (nombre del juego)"),
        limit: z.number().int().min(1).max(20).default(5).describe("Máximo de resultados"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ term, limit }) => {
      try {
        const data = await steamStoreRequest<{
          items?: { id: number; name: string; type?: string }[];
        }>("api/storesearch/", { term, cc: "us", l: "english" });
        const items = (data.items ?? []).slice(0, limit);
        if (!items.length) {
          return textResult("No se encontraron juegos para ese término.");
        }
        return textResult(items.map((i) => ({ appid: i.id, name: i.name, type: i.type })));
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    }
  );

  // 14. Estado de bans (VAC / comunidad / economy) de uno o varios usuarios
  server.registerTool(
    "get_player_bans",
    {
      title: "Estado de bans de un jugador",
      description:
        "Devuelve el estado de VAC, comunidad, economy y game bans de uno o varios SteamIDs. Incluye el appid de cada game ban específico cuando aplica.",
      inputSchema: {
        steamids: z
          .array(z.string())
          .min(1)
          .max(100)
          .describe("Lista de SteamID64 a consultar"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ steamids }) => {
      try {
        const data = await steamRequest<{
          players: {
            SteamId: string;
            CommunityBanned: boolean;
            VACBanned: boolean;
            NumberOfVACBans: number;
            DaysSinceLastBan: number;
            NumberOfGameBans: number;
            EconomyBan: string;
            bans?: {
              AppIdMin: number;
              AppIdMax: number;
              BanType: number;
              BanStartTime: number;
              BanProviderId: number;
            }[];
          }[];
        }>("ISteamUser/GetPlayerBans/v1", { steamids: steamids.join(",") });

        const result = data.players.map((p) => ({
          steamid: p.SteamId,
          community_banned: p.CommunityBanned,
          vac_banned: p.VACBanned,
          number_of_vac_bans: p.NumberOfVACBans,
          days_since_last_ban: p.DaysSinceLastBan,
          number_of_game_bans: p.NumberOfGameBans,
          economy_ban: p.EconomyBan,
          bans: (p.bans ?? []).map((b) => ({
            appid: b.AppIdMin === b.AppIdMax ? b.AppIdMin : `${b.AppIdMin}-${b.AppIdMax}`,
            ban_type: b.BanType,
            ban_start_time: b.BanStartTime,
          })),
        }));

        return textResult(result);
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    }
  );
}
