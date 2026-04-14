import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import type {
  ServiceReadApi,
  TokenListQuery,
  TokenSortField,
  TradeListQuery,
} from "./contracts.js";

type Awaitable<T> = T | Promise<T>;

export interface ApiDataService
  extends Omit<ServiceReadApi, "isReady" | "listTrades"> {
  isHealthy?: () => Awaitable<boolean>;
  isReady: () => Awaitable<boolean>;
  listTrades?: ServiceReadApi["listTrades"];
}

export interface ApiServerOptions {
  maxPageSize?: number;
}

export type ApiRequestHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => void | Promise<void>;

interface JsonErrorBody {
  ok: false;
  error: {
    code: string;
    message: string;
  };
}

interface JsonSuccessBody<T> {
  ok: true;
  data: T;
}

class ApiHttpError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_MAX_PAGE_SIZE = 200;
const DEFAULT_TOKEN_SORT: TokenSortField = "recent144VolumeSats";
const DEFAULT_ORDER: "asc" | "desc" = "desc";

const TOKEN_SORT_FIELDS = new Set<TokenSortField>([
  "totalTradeCount",
  "totalVolumeSats",
  "latestPriceNanosatsPerAtom",
  "recent144TradeCount",
  "recent144VolumeSats",
  "recent1008TradeCount",
  "recent1008VolumeSats",
  "recent4320TradeCount",
  "recent4320VolumeSats",
  "lastTradeBlockHeight",
  "lastTradeBlockTimestamp",
]);

function sendJson<T>(
  res: ServerResponse,
  statusCode: number,
  body: JsonSuccessBody<T> | JsonErrorBody,
): void {
  const payload = JSON.stringify(body);
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(payload);
}

function toPathSegments(pathname: string): string[] {
  return pathname
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        throw new ApiHttpError(400, "BAD_PATH", "Invalid path segment encoding");
      }
    });
}

function parsePositiveInt(
  rawValue: string | null,
  field: string,
  fallback: number,
  maxValue: number,
): number {
  if (rawValue === null || rawValue.length === 0) {
    return fallback;
  }
  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > maxValue) {
    throw new ApiHttpError(
      400,
      "INVALID_QUERY",
      `${field} must be an integer in [1, ${maxValue}]`,
    );
  }
  return parsed;
}

function parseSortOrder(rawValue: string | null): "asc" | "desc" {
  if (rawValue === null || rawValue.length === 0) {
    return DEFAULT_ORDER;
  }
  if (rawValue === "asc" || rawValue === "desc") {
    return rawValue;
  }
  throw new ApiHttpError(400, "INVALID_QUERY", "order must be asc or desc");
}

function parseTokenSortField(rawValue: string | null): TokenSortField {
  if (rawValue === null || rawValue.length === 0) {
    return DEFAULT_TOKEN_SORT;
  }
  if (TOKEN_SORT_FIELDS.has(rawValue as TokenSortField)) {
    return rawValue as TokenSortField;
  }
  throw new ApiHttpError(
    400,
    "INVALID_QUERY",
    `sort must be one of: ${Array.from(TOKEN_SORT_FIELDS).join(", ")}`,
  );
}

function parseReadyOnly(rawValue: string | null): boolean | undefined {
  if (rawValue === null || rawValue.length === 0) {
    return undefined;
  }
  if (rawValue === "true") {
    return true;
  }
  if (rawValue === "false") {
    return false;
  }
  throw new ApiHttpError(400, "INVALID_QUERY", "readyOnly must be true or false");
}

function methodNotAllowed(res: ServerResponse): void {
  sendJson(res, 405, {
    ok: false,
    error: {
      code: "METHOD_NOT_ALLOWED",
      message: "Only GET is supported",
    },
  });
}

function notFound(res: ServerResponse): void {
  sendJson(res, 404, {
    ok: false,
    error: {
      code: "NOT_FOUND",
      message: "Route not found",
    },
  });
}

function sendHttpError(res: ServerResponse, error: ApiHttpError): void {
  sendJson(res, error.statusCode, {
    ok: false,
    error: {
      code: error.code,
      message: error.message,
    },
  });
}

async function routeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  dataService: ApiDataService,
  options: Required<ApiServerOptions>,
): Promise<void> {
  if (req.method !== "GET") {
    methodNotAllowed(res);
    return;
  }

  const parsedUrl = new URL(req.url ?? "/", "http://127.0.0.1");
  const segments = toPathSegments(parsedUrl.pathname);

  if (segments.length === 1 && segments[0] === "healthz") {
    const healthy = dataService.isHealthy ? await dataService.isHealthy() : true;
    sendJson(res, healthy ? 200 : 503, {
      ok: true,
      data: {
        healthy,
      },
    });
    return;
  }

  if (segments.length === 1 && segments[0] === "readyz") {
    const ready = await dataService.isReady();
    sendJson(res, ready ? 200 : 503, {
      ok: true,
      data: {
        ready,
      },
    });
    return;
  }

  if (segments.length === 2 && segments[0] === "api" && segments[1] === "status") {
    const [healthy, status] = await Promise.all([
      dataService.isHealthy ? dataService.isHealthy() : true,
      dataService.getStatus(),
    ]);

    sendJson(res, 200, {
      ok: true,
      data: {
        healthy,
        ...status,
      },
    });
    return;
  }

  if (segments.length === 2 && segments[0] === "api" && segments[1] === "tokens") {
    const query: TokenListQuery = {
      page: parsePositiveInt(
        parsedUrl.searchParams.get("page"),
        "page",
        DEFAULT_PAGE,
        Number.MAX_SAFE_INTEGER,
      ),
      pageSize: parsePositiveInt(
        parsedUrl.searchParams.get("pageSize"),
        "pageSize",
        DEFAULT_PAGE_SIZE,
        options.maxPageSize,
      ),
      sort: parseTokenSortField(parsedUrl.searchParams.get("sort")),
      order: parseSortOrder(parsedUrl.searchParams.get("order")),
      readyOnly: parseReadyOnly(parsedUrl.searchParams.get("readyOnly")),
    };
    const result = await dataService.listTokens(query);
    sendJson(res, 200, { ok: true, data: result });
    return;
  }

  if (
    segments.length === 3 &&
    segments[0] === "api" &&
    segments[1] === "tokens"
  ) {
    const tokenId = segments[2];
    const token = await dataService.getToken(tokenId);
    if (!token) {
      throw new ApiHttpError(404, "TOKEN_NOT_FOUND", `Token not found: ${tokenId}`);
    }
    sendJson(res, 200, { ok: true, data: token });
    return;
  }

  if (
    segments.length === 4 &&
    segments[0] === "api" &&
    segments[1] === "tokens" &&
    segments[3] === "trades"
  ) {
    const tokenId = segments[2];
    const token = await dataService.getToken(tokenId);
    if (!token) {
      throw new ApiHttpError(404, "TOKEN_NOT_FOUND", `Token not found: ${tokenId}`);
    }
    const query: TradeListQuery = {
      page: parsePositiveInt(
        parsedUrl.searchParams.get("page"),
        "page",
        DEFAULT_PAGE,
        Number.MAX_SAFE_INTEGER,
      ),
      pageSize: parsePositiveInt(
        parsedUrl.searchParams.get("pageSize"),
        "pageSize",
        DEFAULT_PAGE_SIZE,
        options.maxPageSize,
      ),
    };
    const result = await dataService.listTokenTrades(tokenId, query);
    sendJson(res, 200, { ok: true, data: result });
    return;
  }

  if (segments.length === 2 && segments[0] === "api" && segments[1] === "trades") {
    if (!dataService.listTrades) {
      throw new ApiHttpError(
        404,
        "ENDPOINT_DISABLED",
        "Global trades endpoint is disabled",
      );
    }
    const query: TradeListQuery = {
      page: parsePositiveInt(
        parsedUrl.searchParams.get("page"),
        "page",
        DEFAULT_PAGE,
        Number.MAX_SAFE_INTEGER,
      ),
      pageSize: parsePositiveInt(
        parsedUrl.searchParams.get("pageSize"),
        "pageSize",
        DEFAULT_PAGE_SIZE,
        options.maxPageSize,
      ),
    };
    const result = await dataService.listTrades(query);
    sendJson(res, 200, { ok: true, data: result });
    return;
  }

  notFound(res);
}

export function createApiServer(
  dataService: ApiDataService,
  options: ApiServerOptions = {},
): Server {
  return createServer(createApiRequestHandler(dataService, options));
}

export function createApiRequestHandler(
  dataService: ApiDataService,
  options: ApiServerOptions = {},
): ApiRequestHandler {
  const resolvedOptions: Required<ApiServerOptions> = {
    maxPageSize: options.maxPageSize ?? DEFAULT_MAX_PAGE_SIZE,
  };

  return async (req, res) => {
    try {
      await routeRequest(req, res, dataService, resolvedOptions);
    } catch (error) {
      if (error instanceof ApiHttpError) {
        sendHttpError(res, error);
        return;
      }

      sendJson(res, 500, {
        ok: false,
        error: {
          code: "INTERNAL_ERROR",
          message: "Internal server error",
        },
      });
    }
  };
}
