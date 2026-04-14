import type { Server } from "node:http";

import type { AppConfig } from "../lib/config.js";
import { createApiServer, type ApiDataService } from "./apiServer.js";
import type { AgoraTokenService } from "./service.js";

type Logger = Pick<Console, "info" | "error">;

export interface ApplicationRuntime {
  server: Server;
  close: () => Promise<void>;
}

interface RuntimeOptions {
  logger?: Logger;
  createServer?: (dataService: ApiDataService, port: number) => Server;
  listen?: (server: Server, port: number) => Promise<void>;
  closeServer?: (server: Server) => Promise<void>;
}

export function toApiDataService(service: AgoraTokenService): ApiDataService {
  return {
    isHealthy: () => service.getStatus().phase !== "error",
    isReady: () => service.isReady(),
    getStatus: () => service.getStatus(),
    listTokens: (query) => service.listTokens(query),
    getToken: (tokenId) => service.getToken(tokenId),
    listTokenTrades: (tokenId, query) => service.listTokenTrades(tokenId, query),
    listTrades: (query) => service.listTrades(query),
  };
}

export function listenServer(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onListening = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      server.off("error", onError);
    };

    server.once("error", onError);
    server.listen(port, onListening);
  });
}

export function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

export async function startApplication(
  service: AgoraTokenService,
  config: AppConfig,
  options: RuntimeOptions = {},
): Promise<ApplicationRuntime> {
  const logger = options.logger ?? console;
  const createServerFn =
    options.createServer ??
    ((dataService: ApiDataService) =>
      createApiServer(dataService, {
        maxPageSize: config.apiPageSizeMax,
      }));
  const listenFn = options.listen ?? listenServer;
  const closeServerFn = options.closeServer ?? closeServer;

  logger.info(
    `server bootstrapping | chronik=${config.chronikUrl} | sqlite=${config.sqlitePath} | port=${config.serverPort}`,
  );

  await service.start();

  let server: Server | null = null;
  try {
    server = createServerFn(toApiDataService(service), config.serverPort);
    await listenFn(server, config.serverPort);
  } catch (error) {
    service.stop();
    if (server) {
      try {
        await closeServerFn(server);
      } catch {
        // Best-effort cleanup for partially initialized servers.
      }
    }
    throw error;
  }

  logger.info(
    `server ready | port=${config.serverPort} | readyTokens=${service.getStatus().readyTokenCount}`,
  );

  return {
    server,
    close: async () => {
      service.stop();
      await closeServerFn(server);
    },
  };
}
