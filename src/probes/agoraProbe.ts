import { Agora } from "ecash-agora";
import { ChronikClient } from "chronik-client";

const chronikUrl =
  process.env.CHRONIK_URL?.trim() || "https://chronik-native1.fabien.cash";

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
  const chronik = new ChronikClient([chronikUrl]);
  const agora = new Agora(chronik);

  const tokenIds = await agora.allOfferedTokenIds();
  console.log(
    JSON.stringify(
      {
        chronikUrl,
        activeTokenCount: tokenIds.length,
        sampleTokenIds: tokenIds.slice(0, 10),
      },
      null,
      2,
    ),
  );

  const tokenId = tokenIds[0];
  if (!tokenId) {
    console.log("No active Agora tokens returned by chronik.");
    return;
  }

  const history = await agora.historicOffers({
    type: "TOKEN_ID",
    tokenId,
    table: "HISTORY",
    page: 0,
    pageSize: 5,
  });

  const normalized = {
    tokenId,
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
  };

  console.log(JSON.stringify(formatValue(normalized), null, 2));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
