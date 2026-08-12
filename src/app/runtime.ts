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
  listen?: (server: Server, port: number, host: string) => Promise<void>;
  closeServer?: (server: Server) => Promise<void>;
}

export function toApiDataService(service: AgoraTokenService): ApiDataService {
  return {
    isHealthy: () => service.isHealthy(),
    isReady: () => service.isReady(),
    getStatus: () => service.getStatus(),
    listTokens: (query) => service.listTokens(query),
    getToken: (tokenId) => service.getToken(tokenId),
    getAnalyticsSummary: (hours) => service.getAnalyticsSummary(hours),
    listEndpointAnalytics: (hours) => service.listEndpointAnalytics(hours),
    getEndpointAnalytics: (routeKey, hours) =>
      service.getEndpointAnalytics(routeKey, hours),
    listTokenVisits: (query) => service.listTokenVisits(query),
    getTokenVisitAnalytics: (tokenId, hours) =>
      service.getTokenVisitAnalytics(tokenId, hours),
    listTokenTrades: (tokenId, query) => service.listTokenTrades(tokenId, query),
    listTokenCandles: (tokenId, query) => service.listTokenCandles(tokenId, query),
    listTrades: (query) => service.listTrades(query),
    listTokenReviews: (tokenId, query) =>
      service.listTokenReviews(tokenId, query),
    getTokenReviewSummary: (tokenId) => service.getTokenReviewSummary(tokenId),
    getTokenProjectInfo: (tokenId) => service.getTokenProjectInfo(tokenId),
    createReviewInvoice: (tokenId, input) =>
      service.createReviewInvoice(tokenId, input),
    getReviewInvoice: (invoiceId) => service.getReviewInvoice(invoiceId),
    submitReviewInvoiceTx: (invoiceId, input) =>
      service.submitReviewInvoiceTx(invoiceId, input),
    createProjectInfoInvoice: (tokenId, input) =>
      service.createProjectInfoInvoice(tokenId, input),
    getProjectInfoInvoice: (invoiceId) =>
      service.getProjectInfoInvoice(invoiceId),
    submitProjectInfoInvoiceTx: (invoiceId, input) =>
      service.submitProjectInfoInvoiceTx(invoiceId, input),
  };
}

export function listenServer(server: Server, port: number, host: string): Promise<void> {
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
    server.listen(port, host, onListening);
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
        maxAnalyticsHours: config.analyticsHourlyRetentionHours,
        analyticsRecorder: {
          recordApiAccess: (entry) => service.recordApiAccess(entry),
        },
      }));
  const listenFn = options.listen ?? listenServer;
  const closeServerFn = options.closeServer ?? closeServer;

  logger.info(
    `server bootstrapping | chronik=${config.chronikUrl} | sqlite=${config.sqlitePath} | listen=${config.serverHost}:${config.serverPort}`,
  );

  await service.start();

  let server: Server | null = null;
  try {
    server = createServerFn(toApiDataService(service), config.serverPort);
    await listenFn(server, config.serverPort, config.serverHost);
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
