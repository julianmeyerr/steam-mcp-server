import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import tls from "node:tls";
import axios, { AxiosError } from "axios";

const STEAM_API_BASE_URL = "https://api.steampowered.com";

/**
 * Construye la lista de CAs de confianza para axios.
 *
 * Tu red (UniFi / gateway con SSL inspection) intercepta TLS y presenta un
 * certificado firmado por una CA privada ("UniFi SSL Certificate Authority")
 * que NO está en el almacén de Node. Para solucionarlo sin bajar la seguridad:
 *   1. Exportá el certificado raíz de tu UniFi y guardalo en `certs/local-ca.pem`
 *      (o apuntá STEAM_EXTRA_CA a su ruta). Se suma a las CAs del sistema.
 *   2. Si no podés obtener la CA, habilitá STEAM_TLS_INSECURE=1 en el .env
 *      para aceptar el certificado del proxy (solo en tu red local).
 */
function buildCaList(): string[] | undefined {
  const caList: string[] = [...tls.rootCertificates];

  const extraPaths = [
    process.env.STEAM_EXTRA_CA,
    process.env.NODE_EXTRA_CA_CERTS,
    path.resolve(process.cwd(), "certs", "local-ca.pem"),
  ];

  for (const p of extraPaths) {
    if (!p) continue;
    try {
      const content = fs.readFileSync(p, "utf8");
      caList.push(content);
    } catch {
      // El archivo no existe o no se puede leer: lo ignoramos.
    }
  }

  return caList.length > tls.rootCertificates.length ? caList : undefined;
}

const httpsAgent = new https.Agent({
  ca: buildCaList(),
  rejectUnauthorized: process.env.STEAM_TLS_INSECURE !== "1",
  keepAlive: true,
});

const STEAM_STORE_BASE_URL = "https://store.steampowered.com";

/**
 * Llama a la API de la tienda de Steam (store.steampowered.com), que no requiere
 * API key. Útil para búsquedas por nombre (p. ej. storesearch).
 */
export async function steamStoreRequest<T>(
  path: string,
  params: Record<string, string | number | boolean | undefined>
): Promise<T> {
  const cleanParams: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) cleanParams[k] = v;
  }

  try {
    const response = await axios.get(`${STEAM_STORE_BASE_URL}/${path}`, {
      params: cleanParams,
      timeout: 15000,
      httpsAgent,
    });
    return response.data as T;
  } catch (error) {
    throw new Error(formatSteamError(error));
  }
}


/**
 * Llama a un endpoint de la Steam Web API.
 * `interfacePath` tiene el formato "Interface/Method/vXXXX",
 * por ejemplo "ISteamUser/GetPlayerSummaries/v0002".
 */
export async function steamRequest<T>(
  interfacePath: string,
  params: Record<string, string | number | boolean | undefined>
): Promise<T> {
  const apiKey = process.env.STEAM_API_KEY;
  if (!apiKey) {
    throw new Error(
      "STEAM_API_KEY no está configurada. Definila en el archivo .env."
    );
  }

  // Steam descarta los params undefined, así que los filtramos antes de armar el request
  const cleanParams: Record<string, string | number | boolean> = {
    key: apiKey,
    format: "json",
  };
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) cleanParams[k] = v;
  }

  try {
    const response = await axios.get(`${STEAM_API_BASE_URL}/${interfacePath}`, {
      params: cleanParams,
      timeout: 15000,
      httpsAgent,
    });
    return response.data as T;
  } catch (error) {
    throw new Error(formatSteamError(error));
  }
}

function formatSteamError(error: unknown): string {
  if (error instanceof AxiosError) {
    const status = error.response?.status;
    if (status === 401 || status === 403) {
      return "Error: API key inválida o sin permisos para este endpoint.";
    }
    if (status === 404) {
      return "Error: Recurso no encontrado (revisá el steamid o appid).";
    }
    if (status === 429) {
      return "Error: Se alcanzó el límite de requests a la Steam Web API. Esperá unos minutos.";
    }
    if (error.code === "ECONNABORTED") {
      return "Error: Timeout al contactar a Steam. Intentá de nuevo.";
    }
    if (status) {
      return `Error: la Steam Web API respondió con status ${status}.`;
    }
  }
  return `Error inesperado: ${error instanceof Error ? error.message : String(error)}`;
}
