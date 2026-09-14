import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import tls from "node:tls";
import axios, { AxiosError } from "axios";

const STEAM_API_BASE_URL = "https://api.steampowered.com";

type RequestParams = Record<string, string | number | boolean | undefined>;

const DEFAULT_CACHE_TTL_MS = 30_000;
const DEFAULT_MIN_REQUEST_INTERVAL_MS = 100;
const MAX_CACHE_ENTRIES = 100;

type CacheEntry = {
  expiresAt: number;
  value: unknown;
};

const responseCache = new Map<string, CacheEntry>();
const inFlightRequests = new Map<string, Promise<unknown>>();
let requestQueue = Promise.resolve();
let lastRequestAt = 0;

function readMilliseconds(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

const cacheTtlMs = readMilliseconds("STEAM_CACHE_TTL_MS", DEFAULT_CACHE_TTL_MS);
const minRequestIntervalMs = readMilliseconds(
  "STEAM_MIN_REQUEST_INTERVAL_MS",
  DEFAULT_MIN_REQUEST_INTERVAL_MS
);

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

function cleanParams(params: RequestParams): Record<string, string | number | boolean> {
  const result: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function getCacheKey(
  namespace: string,
  interfacePath: string,
  params: Record<string, string | number | boolean>
): string {
  return JSON.stringify([
    namespace,
    interfacePath,
    Object.entries(params).sort(([a], [b]) => a.localeCompare(b)),
  ]);
}

function scheduleRequest<T>(request: () => Promise<T>): Promise<T> {
  const requestStart = requestQueue.then(async () => {
    const elapsed = Date.now() - lastRequestAt;
    const waitMs = Math.max(0, minRequestIntervalMs - elapsed);
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    lastRequestAt = Date.now();
  });

  requestQueue = requestStart.then(
    () => undefined,
    () => undefined
  );
  return requestStart.then(request);
}

async function request<T>(
  baseUrl: string,
  interfacePath: string,
  params: RequestParams,
  cacheNamespace: string,
  cacheParams: RequestParams = params
): Promise<T> {
  const cleanRequestParams = cleanParams(params);
  const cacheKey = getCacheKey(cacheNamespace, interfacePath, cleanParams(cacheParams));

  if (cacheTtlMs > 0) {
    const cached = responseCache.get(cacheKey);
    if (cached) {
      if (cached.expiresAt > Date.now()) {
        return cached.value as T;
      }
      responseCache.delete(cacheKey);
    }
  }

  const existingRequest = inFlightRequests.get(cacheKey);
  if (existingRequest) return existingRequest as Promise<T>;

  const pendingRequest = (async () => {
    try {
      const response = await scheduleRequest(() =>
        axios.get(`${baseUrl}/${interfacePath}`, {
          params: cleanRequestParams,
          timeout: 15000,
          httpsAgent,
        })
      );
      const data = response.data as T;

      if (cacheTtlMs > 0) {
        if (responseCache.size >= MAX_CACHE_ENTRIES) {
          const oldestKey = responseCache.keys().next().value;
          if (oldestKey) responseCache.delete(oldestKey);
        }
        responseCache.set(cacheKey, {
          expiresAt: Date.now() + cacheTtlMs,
          value: data,
        });
      }

      return data;
    } catch (error) {
      throw new Error(formatSteamError(error));
    }
  })();

  inFlightRequests.set(cacheKey, pendingRequest);
  try {
    return await pendingRequest;
  } finally {
    inFlightRequests.delete(cacheKey);
  }
}

/**
 * Llama a la API de la tienda de Steam (store.steampowered.com), que no requiere
 * API key. Útil para búsquedas por nombre (p. ej. storesearch).
 */
export async function steamStoreRequest<T>(
  path: string,
  params: RequestParams
): Promise<T> {
  return request<T>(STEAM_STORE_BASE_URL, path, params, "store");
}


/**
 * Llama a un endpoint de la Steam Web API.
 * `interfacePath` tiene el formato "Interface/Method/vXXXX",
 * por ejemplo "ISteamUser/GetPlayerSummaries/v0002".
 */
export async function steamRequest<T>(
  interfacePath: string,
  params: RequestParams
): Promise<T> {
  const apiKey = process.env.STEAM_API_KEY;
  if (!apiKey) {
    throw new Error(
      "STEAM_API_KEY no está configurada. Definila en el archivo .env."
    );
  }

  const requestParams: RequestParams = {
    key: apiKey,
    format: "json",
    ...params,
  };
  return request<T>(
    STEAM_API_BASE_URL,
    interfacePath,
    requestParams,
    "steam-authenticated",
    { format: "json", ...params }
  );
}

/** Llama a un endpoint público de Steam que no requiere API key. */
export async function steamPublicRequest<T>(
  interfacePath: string,
  params: RequestParams
): Promise<T> {
  return request<T>(
    STEAM_API_BASE_URL,
    interfacePath,
    { format: "json", ...params },
    "steam-public"
  );
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
