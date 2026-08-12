import { createRequire } from "node:module";

import { Agora, type AgoraOffer } from "ecash-agora";
import type { ChronikClient, Tx, TxInput, TxOutput } from "chronik-client";

import { retryAsync, withTimeout } from "./async.js";
import { priceNanosatsPerAtom, stringifyBigInts } from "./bigint.js";
import type { AppConfig } from "./config.js";
import type { AppDatabase } from "./db.js";
import type {
  ActiveTokenSeed,
  ProcessedTradeRecord,
  TokenStatsRecord,
  TokenSyncResult,
} from "./types.js";

export const AGORA_PLUGIN_NAME = "agora";
export const AGORA_LOKAD_ID_HEX = "41475230";
export const GROUP_PREFIX_ACTIVE_FUNGIBLE = "46";
export const GROUP_PREFIX_ACTIVE_GROUP = "47";
export const GROUP_PREFIX_TOKEN_ID = "54";
const RAW_CONTEXT_FALLBACK_PAGE_COUNT = 5;

interface RawOfferSpendContext {
  spendTxid: string;
  blockHeight: number | null;
  blockHash: string | null;
  blockTimestamp: number | null;
}

export interface SyncDependencies {
  chronik: Pick<
    ChronikClient,
    "plugin" | "tx" | "ws" | "blockchainInfo" | "token"
  >;
  agora: Pick<
    Agora,
    | "historicOffers"
    | "subscribeWs"
    | "unsubscribeWs"
    | "offeredFungibleTokenIds"
  >;
}

export interface DiscoveryPageProgress {
  page: number;
  startHex: string;
  fetchedGroupCount: number;
  fungibleGroupCount: number;
  nextStart: string;
}

export interface TokenPageProgress {
  tokenId: string;
  page: number;
  numPages: number;
  scannedTradeCount: number;
  insertedTradeCount: number;
}

export interface SyncProgressHandlers {
  onDiscoveryPage?: (progress: DiscoveryPageProgress) => void;
  onTokenSyncStart?: (tokenId: string, index: number, total: number) => void;
  onTokenSyncPage?: (progress: TokenPageProgress) => void;
  onTokenSyncComplete?: (
    result: TokenSyncResult,
    index: number,
    total: number,
  ) => void;
}

const require = createRequire(import.meta.url);

export function createSyncDependencies(config: AppConfig): SyncDependencies {
  const chronik = new (requireChronikClient())(
    config.chronikUrls ?? [config.chronikUrl],
  );
  const agora = new (requireAgora())(chronik);
  return { chronik, agora };
}

function requireChronikClient(): typeof ChronikClient {
  // Lazy loading keeps tests lightweight and avoids fighting ESM class types.
  const module = require("chronik-client") as { ChronikClient: typeof ChronikClient };
  return module.ChronikClient;
}

function requireAgora(): typeof Agora {
  const module = require("ecash-agora") as { Agora: typeof Agora };
  return module.Agora;
}

export function tokenIdGroupHex(tokenId: string): string {
  return `${GROUP_PREFIX_TOKEN_ID}${tokenId}`;
}

export function normalizeHex(value: string | Uint8Array): string {
  if (typeof value === "string") {
    return value;
  }

  return Buffer.from(value).toString("hex");
}

export function offerKey(txid: string | Uint8Array, outIdx: number): string {
  return `${normalizeHex(txid)}:${outIdx}`;
}

export function normalizeTokenId(tokenId: string | Uint8Array): string {
  return normalizeHex(tokenId);
}

function hasAgoraPlugin(input: TxInput): boolean {
  return input.plugins?.[AGORA_PLUGIN_NAME] !== undefined;
}

export function mapRawOfferSpends(txs: Tx[]): Map<string, RawOfferSpendContext> {
  const contexts = new Map<string, RawOfferSpendContext>();

  for (const tx of txs) {
    for (const input of tx.inputs) {
      if (!hasAgoraPlugin(input)) {
        continue;
      }

      contexts.set(offerKey(input.prevOut.txid, input.prevOut.outIdx), {
        spendTxid: normalizeHex(tx.txid),
        blockHeight: tx.block?.height ?? null,
        blockHash: tx.block?.hash ?? null,
        blockTimestamp: tx.block?.timestamp ?? null,
      });
    }
  }

  return contexts;
}

export function extractAgoraTokenIdsFromTx(tx: Tx): string[] {
  const tokenIds = new Set<string>();

  const collectGroups = (
    groups: string[] | undefined,
  ): void => {
    if (!groups) {
      return;
    }

    for (const group of groups) {
      if (
        group.startsWith(GROUP_PREFIX_TOKEN_ID) ||
        group.startsWith(GROUP_PREFIX_ACTIVE_FUNGIBLE) ||
        group.startsWith(GROUP_PREFIX_ACTIVE_GROUP)
      ) {
        tokenIds.add(group.slice(2));
      }
    }
  };

  const collectEntries = (
    plugins:
      | Record<
          string,
          {
            groups: string[];
          }
        >
      | undefined,
  ): void => {
    const agoraEntry = plugins?.[AGORA_PLUGIN_NAME];
    collectGroups(agoraEntry?.groups);
  };

  for (const input of tx.inputs) {
    collectEntries(input.plugins as Record<string, { groups: string[] }> | undefined);
  }

  for (const output of tx.outputs) {
    collectEntries(output.plugins as Record<string, { groups: string[] }> | undefined);
  }

  return [...tokenIds];
}

export function extractAgoraFungibleTokenIdsFromTx(tx: Tx): string[] {
  const tokenIds = new Set<string>();

  for (const entry of [...tx.inputs, ...tx.outputs]) {
    const groups = entry.plugins?.[AGORA_PLUGIN_NAME]?.groups;
    if (!groups) {
      continue;
    }

    for (const group of groups) {
      if (group.startsWith(GROUP_PREFIX_ACTIVE_FUNGIBLE)) {
        tokenIds.add(group.slice(GROUP_PREFIX_ACTIVE_FUNGIBLE.length));
      }
    }
  }

  return [...tokenIds];
}

export function normalizeTakenOffer(
  offer: AgoraOffer,
  context: RawOfferSpendContext,
): ProcessedTradeRecord | null {
  if (
    offer.status !== "TAKEN" ||
    !offer.takenInfo ||
    context.blockHeight === null ||
    context.blockTimestamp === null
  ) {
    return null;
  }

  const paidSats = offer.takenInfo.sats;
  const soldAtoms = offer.takenInfo.atoms;

  return {
    offerTxid: normalizeHex(offer.outpoint.txid),
    offerOutIdx: offer.outpoint.outIdx,
    spendTxid: context.spendTxid,
    tokenId: normalizeTokenId(offer.token.tokenId),
    variantType: offer.variant.type,
    paidSats: paidSats.toString(),
    soldAtoms: soldAtoms.toString(),
    priceNanosatsPerAtom: priceNanosatsPerAtom(paidSats, soldAtoms).toString(),
    takerScriptHex: offer.takenInfo.takerScriptHex ?? null,
    blockHeight: context.blockHeight,
    blockHash: context.blockHash,
    blockTimestamp: context.blockTimestamp,
    rawTradeJson: JSON.stringify(
      stringifyBigInts({
        outpoint: offer.outpoint,
        token: offer.token,
        variantType: offer.variant.type,
        takenInfo: offer.takenInfo,
      }),
    ),
  };
}

function compareTradeFreshness(
  left: Pick<
    ProcessedTradeRecord,
    "blockHeight" | "blockTimestamp" | "offerTxid" | "offerOutIdx"
  >,
  right: Pick<
    ProcessedTradeRecord,
    "blockHeight" | "blockTimestamp" | "offerTxid" | "offerOutIdx"
  >,
): number {
  const leftHeight = left.blockHeight ?? -1;
  const rightHeight = right.blockHeight ?? -1;
  if (leftHeight !== rightHeight) {
    return leftHeight - rightHeight;
  }

  const leftTs = left.blockTimestamp ?? -1;
  const rightTs = right.blockTimestamp ?? -1;
  if (leftTs !== rightTs) {
    return leftTs - rightTs;
  }

  if (left.offerTxid !== right.offerTxid) {
    return left.offerTxid.localeCompare(right.offerTxid);
  }

  return left.offerOutIdx - right.offerOutIdx;
}

export function applyTradeStatsDelta(
  current: TokenStatsRecord | null,
  tokenId: string,
  insertedTrades: ProcessedTradeRecord[],
): TokenStatsRecord {
  let tradeCount = current?.tradeCount ?? 0;
  let cumulativePaidSats = BigInt(current?.cumulativePaidSats ?? "0");

  let lastTrade: Pick<
    TokenStatsRecord,
    | "lastTradeOfferTxid"
    | "lastTradeOfferOutIdx"
    | "lastTradeBlockHeight"
    | "lastTradeBlockTimestamp"
    | "lastTradePriceNanosatsPerAtom"
  > = {
    lastTradeOfferTxid: current?.lastTradeOfferTxid ?? null,
    lastTradeOfferOutIdx: current?.lastTradeOfferOutIdx ?? null,
    lastTradeBlockHeight: current?.lastTradeBlockHeight ?? null,
    lastTradeBlockTimestamp: current?.lastTradeBlockTimestamp ?? null,
    lastTradePriceNanosatsPerAtom: current?.lastTradePriceNanosatsPerAtom ?? null,
  };

  for (const trade of insertedTrades) {
    tradeCount += 1;
    cumulativePaidSats += BigInt(trade.paidSats);

    const hasCurrentLastTrade =
      lastTrade.lastTradeOfferTxid !== null &&
      lastTrade.lastTradeOfferOutIdx !== null;

    if (
      !hasCurrentLastTrade ||
      compareTradeFreshness(
        {
          offerTxid: lastTrade.lastTradeOfferTxid as string,
          offerOutIdx: lastTrade.lastTradeOfferOutIdx as number,
          blockHeight: lastTrade.lastTradeBlockHeight,
          blockTimestamp: lastTrade.lastTradeBlockTimestamp,
        },
        trade,
      ) < 0
    ) {
      lastTrade = {
        lastTradeOfferTxid: trade.offerTxid,
        lastTradeOfferOutIdx: trade.offerOutIdx,
        lastTradeBlockHeight: trade.blockHeight,
        lastTradeBlockTimestamp: trade.blockTimestamp,
        lastTradePriceNanosatsPerAtom: trade.priceNanosatsPerAtom,
      };
    }
  }

  return {
    tokenId,
    tradeCount,
    cumulativePaidSats: cumulativePaidSats.toString(),
    lastTradeOfferTxid: lastTrade.lastTradeOfferTxid,
    lastTradeOfferOutIdx: lastTrade.lastTradeOfferOutIdx,
    lastTradeBlockHeight: lastTrade.lastTradeBlockHeight,
    lastTradeBlockTimestamp: lastTrade.lastTradeBlockTimestamp,
    lastTradePriceNanosatsPerAtom: lastTrade.lastTradePriceNanosatsPerAtom,
  };
}

export async function discoverActiveTokens(
  deps: SyncDependencies,
  config: AppConfig,
  progress?: SyncProgressHandlers,
): Promise<ActiveTokenSeed[]> {
  const plugin = deps.chronik.plugin(AGORA_PLUGIN_NAME);
  const tokenIds = new Set<string>();
  let nextStart: string | undefined;
  let page = 0;

  do {
    const label = `Agora active token discovery page starting at ${nextStart || GROUP_PREFIX_ACTIVE_FUNGIBLE}`;
    const groups = await retryAsync(
      () =>
        withTimeout(
          plugin.groups(
            GROUP_PREFIX_ACTIVE_FUNGIBLE,
            nextStart,
            config.activeGroupPageSize,
          ),
          config.requestTimeoutMs,
          label,
        ),
      config.requestRetryCount,
      label,
    );

    let fungibleGroupCount = 0;
    for (const { group } of groups.groups) {
      if (!group.startsWith(GROUP_PREFIX_ACTIVE_FUNGIBLE)) {
        continue;
      }

      tokenIds.add(group.slice(GROUP_PREFIX_ACTIVE_FUNGIBLE.length));
      fungibleGroupCount += 1;
    }

    progress?.onDiscoveryPage?.({
      page,
      startHex: nextStart ?? "",
      fetchedGroupCount: groups.groups.length,
      fungibleGroupCount,
      nextStart: groups.nextStart,
    });

    nextStart = groups.nextStart;
    page += 1;
    const pageDelayMs = config.discoveryPageDelayMs ?? 100;
    if (nextStart !== "" && pageDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, pageDelayMs));
    }
  } while (nextStart !== "");

  return [...tokenIds].map((tokenId) => ({
    tokenId,
    groupHex: `${GROUP_PREFIX_ACTIVE_FUNGIBLE}${tokenId}`,
    groupPrefixHex: GROUP_PREFIX_ACTIVE_FUNGIBLE,
    kind: "FUNGIBLE",
  }));
}

export async function syncTokenHistory(
  db: AppDatabase,
  deps: SyncDependencies,
  config: AppConfig,
  tokenId: string,
  mode: "full" | "tail",
  progress?: SyncProgressHandlers,
): Promise<TokenSyncResult> {
  const plugin = deps.chronik.plugin(AGORA_PLUGIN_NAME);
  const insertedTrades: ProcessedTradeRecord[] = [];
  const rawContextCache = new Map<string, Map<number, Map<string, RawOfferSpendContext>>>();
  const rawNumPagesByGroup = new Map<string, number>();
  let page = 0;
  let pageCount = 0;
  let numPages = 1;
  let scannedTradeCount = 0;
  const maxPages = mode === "tail" ? config.tailPageCount : Number.POSITIVE_INFINITY;
  const primaryRawGroupHex = tokenIdGroupHex(tokenId);
  const fallbackRawGroupHex = `${GROUP_PREFIX_ACTIVE_FUNGIBLE}${tokenId}`;

  const loadRawContexts = async (
    groupHex: string,
    rawPage: number,
  ): Promise<Map<string, RawOfferSpendContext>> => {
    const pagesByGroup = rawContextCache.get(groupHex) ?? new Map();
    const cached = pagesByGroup.get(rawPage);
    if (cached) {
      return cached;
    }

    const label = `Chronik raw history ${tokenId} group ${groupHex.slice(0, 2)} page ${rawPage}`;
    const rawHistory = await retryAsync(
      () =>
        withTimeout(
          plugin.history(groupHex, rawPage, config.historyPageSize),
          config.requestTimeoutMs,
          label,
        ),
      config.requestRetryCount,
      label,
    );
    const contexts = mapRawOfferSpends(rawHistory.txs);
    pagesByGroup.set(rawPage, contexts);
    rawContextCache.set(groupHex, pagesByGroup);
    rawNumPagesByGroup.set(groupHex, rawHistory.numPages);
    return contexts;
  };

  const findRawContext = async (
    key: string,
    currentPage: number,
  ): Promise<RawOfferSpendContext | undefined> => {
    const currentContexts = await loadRawContexts(primaryRawGroupHex, currentPage);
    const current = currentContexts.get(key);
    if (current) {
      return current;
    }

    const minFallbackPage = Math.max(
      0,
      currentPage - RAW_CONTEXT_FALLBACK_PAGE_COUNT,
    );
    const maxFallbackPage = currentPage + RAW_CONTEXT_FALLBACK_PAGE_COUNT;
    for (const groupHex of [primaryRawGroupHex, fallbackRawGroupHex]) {
      for (let rawPage = minFallbackPage; rawPage <= maxFallbackPage; rawPage += 1) {
        const groupNumPages = rawNumPagesByGroup.get(groupHex);
        if (groupNumPages !== undefined && rawPage >= groupNumPages) {
          break;
        }

        let contexts: Map<string, RawOfferSpendContext>;
        try {
          contexts = await loadRawContexts(groupHex, rawPage);
        } catch {
          continue;
        }
        const context = contexts.get(key);
        if (context) {
          return context;
        }
      }
    }

    return undefined;
  };

  while (page < numPages && page < maxPages) {
    const normalizedHistoryLabel = `Agora normalized history ${tokenId} page ${page}`;
    const [rawContexts, normalizedHistory] = await Promise.all([
      loadRawContexts(primaryRawGroupHex, page),
      retryAsync(
        () =>
          withTimeout(
            deps.agora.historicOffers({
              type: "TOKEN_ID",
              tokenId,
              table: "HISTORY",
              page,
              pageSize: config.historyPageSize,
            }),
            config.requestTimeoutMs,
            normalizedHistoryLabel,
          ),
        config.requestRetryCount,
        normalizedHistoryLabel,
      ),
    ]);

    numPages = normalizedHistory.numPages;

    const pageTrades: ProcessedTradeRecord[] = [];
    for (const offer of normalizedHistory.offers) {
      const key = offerKey(offer.outpoint.txid, offer.outpoint.outIdx);
      const context = rawContexts.get(key) ?? await findRawContext(key, page);
      if (!context) {
        continue;
      }

      const trade = normalizeTakenOffer(offer, context);
      if (!trade) {
        continue;
      }

      pageTrades.push(trade);
    }

    scannedTradeCount += pageTrades.length;
    const insertedPageTrades = db.insertProcessedTrades(pageTrades);
    insertedTrades.push(...insertedPageTrades);
    progress?.onTokenSyncPage?.({
      tokenId,
      page,
      numPages,
      scannedTradeCount: pageTrades.length,
      insertedTradeCount: insertedPageTrades.length,
    });
    page += 1;
    pageCount += 1;
  }

  if (insertedTrades.length > 0) {
    const currentStats = db.getTokenStats(tokenId);
    db.replaceTokenStats(applyTradeStatsDelta(currentStats, tokenId, insertedTrades));
  }

  db.markTokenSynced(tokenId, Date.now());

  return {
    tokenId,
    pageCount,
    scannedTradeCount,
    insertedTradeCount: insertedTrades.length,
  };
}

export async function syncTrackedTokens(
  db: AppDatabase,
  deps: SyncDependencies,
  config: AppConfig,
  tokenIds: string[],
  mode: "full" | "tail",
  progress?: SyncProgressHandlers,
): Promise<TokenSyncResult[]> {
  const results: TokenSyncResult[] = [];
  const total = tokenIds.length;
  for (const [index, tokenId] of tokenIds.entries()) {
    progress?.onTokenSyncStart?.(tokenId, index, total);
    const result = await syncTokenHistory(
      db,
      deps,
      config,
      tokenId,
      mode,
      progress,
    );
    results.push(result);
    progress?.onTokenSyncComplete?.(result, index, total);
  }
  return results;
}

export async function syncActiveTokens(
  db: AppDatabase,
  deps: SyncDependencies,
  config: AppConfig,
  mode: "full" | "tail",
  progress?: SyncProgressHandlers,
): Promise<{
  discovered: number;
  synced: TokenSyncResult[];
}> {
  const seeds = await discoverActiveTokens(deps, config, progress);
  db.markAllTrackedTokensInactive();
  for (const seed of seeds) {
    db.upsertTrackedToken(seed);
  }

  return {
    discovered: seeds.length,
    synced: await syncTrackedTokens(
      db,
      deps,
      config,
      db.listTrackedTokenIds(),
      mode,
      progress,
    ),
  };
}
