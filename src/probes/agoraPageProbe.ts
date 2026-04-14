import { Agora } from "ecash-agora";
import { ChronikClient } from "chronik-client";

import { loadConfig } from "../lib/config.js";
import { openDatabase } from "../lib/db.js";
import { syncTokenHistory } from "../lib/agoraSync.js";

const chronikUrl =
  process.env.CHRONIK_URL?.trim() || "https://chronik-native1.fabien.cash";
const groupPrefixHex = process.env.AGORA_GROUP_PREFIX?.trim() ?? "54";
const groupsPageSize = 5;
const historyPageSize = 5;

function formatValue(value: unknown): unknown {
  if (typeof value === "bigint") {
    return value.toString();
  }

  if (Array.isArray(value)) {
    return value.map((item) => formatValue(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, innerValue]) => [
        key,
        formatValue(innerValue),
      ]),
    );
  }

  return value;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const chronik = new ChronikClient([chronikUrl]);
  const agora = new Agora(chronik);
  const plugin = chronik.plugin("agora");

  const groups = await plugin.groups(groupPrefixHex, "", groupsPageSize);
  console.log(
    JSON.stringify(
      formatValue({
        chronikUrl,
        groupPrefixHex,
        groupsPageSize,
        groups,
      }),
      null,
      2,
    ),
  );

  const firstGroup = groups.groups[0]?.group;
  if (!firstGroup) {
    console.log("No Agora groups found for the requested prefix.");
    return;
  }

  if (!groupPrefixHex) {
    const tokenId = firstGroup.slice(2);

    console.log(
      JSON.stringify(
        {
          firstGroup,
          firstGroupPrefixHex: firstGroup.slice(0, 2),
          derivedTokenId: tokenId,
        },
        null,
        2,
      ),
    );

    const rawHistory = await plugin.history(firstGroup, 0, historyPageSize);
    console.log(
      JSON.stringify(
        formatValue({
          rawGroupHistory: {
            groupHex: firstGroup,
            numTxs: rawHistory.numTxs,
            numPages: rawHistory.numPages,
            txs: rawHistory.txs.map((tx) => ({
              txid: tx.txid,
              block: tx.block,
              inputs: tx.inputs.map((input) => ({
                prevOut: input.prevOut,
                outputScript: input.outputScript,
                token: input.token,
                plugins: input.plugins,
              })),
              outputs: tx.outputs.map((output) => ({
                sats: output.sats,
                outputScript: output.outputScript,
                token: output.token,
                plugins: output.plugins,
              })),
            })),
          },
        }),
        null,
        2,
      ),
    );

    const normalizedHistory = await agora.historicOffers({
      type: "TOKEN_ID",
      tokenId,
      table: "HISTORY",
      page: 0,
      pageSize: historyPageSize,
    });
    console.log(
      JSON.stringify(
        formatValue({
          normalizedTokenHistory: {
            tokenId,
            numTxs: normalizedHistory.numTxs,
            numPages: normalizedHistory.numPages,
            offers: normalizedHistory.offers.map((offer) => ({
              outpoint: offer.outpoint,
              status: offer.status,
              variantType: offer.variant.type,
              token: offer.token,
              askedSatsForTakenAtoms:
                offer.takenInfo?.atoms !== undefined
                  ? offer.askedSats(offer.takenInfo.atoms).toString()
                  : null,
              takenInfo: offer.takenInfo,
            })),
          },
        }),
        null,
        2,
      ),
    );

    const memoryDb = openDatabase(":memory:");
    try {
      const syncResult = await syncTokenHistory(
        memoryDb,
        { chronik, agora },
        config,
        tokenId,
        "full",
      );
      const metrics = memoryDb.sqlite
        .prepare(
          `
            SELECT *
            FROM token_stats
            WHERE token_id = ?
          `,
        )
        .get(tokenId);
      const eventCountRow = memoryDb.sqlite
        .prepare(
          `
            SELECT COUNT(*) AS count
            FROM processed_trades
            WHERE token_id = ?
          `,
        )
        .get(tokenId) as { count: number };

      console.log(
        JSON.stringify(
          formatValue({
            inMemorySyncValidation: {
              syncResult,
              storedEventCount: eventCountRow.count,
              metrics,
            },
          }),
          null,
          2,
        ),
      );
    } finally {
      memoryDb.close();
    }
    return;
  }

  if (!firstGroup.startsWith(groupPrefixHex)) {
    console.log("The first group does not match the requested prefix.");
    return;
  }

  const tokenId = firstGroup.slice(groupPrefixHex.length);
  const history = await agora.historicOffers({
    type: "TOKEN_ID",
    tokenId,
    table: "HISTORY",
    page: 0,
    pageSize: historyPageSize,
  });

  console.log(
    JSON.stringify(
      formatValue({
        tokenId,
        historyPageSize,
        numTxs: history.numTxs,
        numPages: history.numPages,
        offers: history.offers.map((offer) => ({
          outpoint: offer.outpoint,
          status: offer.status,
          variantType: offer.variant.type,
          token: offer.token,
          askedSatsFull: offer.askedSats().toString(),
          takenInfo: offer.takenInfo,
        })),
      }),
      null,
      2,
    ),
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
