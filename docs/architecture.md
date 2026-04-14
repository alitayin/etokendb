# Agora Token Metrics Architecture

## Goals

- Discover every token that has ever had Agora activity.
- Persist per-token cumulative Agora trade amount and trade count.
- Persist the minimum per-fill keys needed for dedupe and safe incremental sync.
- Backfill history from scratch, then keep syncing new events continuously.

## Working assumptions to verify

- `ecash-agora` can enumerate or expose historic offers, not only active offers.
- Historic offer parsing yields enough info to identify fills (`TakenInfo`) and related txids.
- `chronik-client` can fetch the underlying transaction and websocket updates needed for live sync.

## Verified Findings

- `https://chronik-native1.fabien.cash` works for Agora queries when the shell exports proxy env vars.
- `https://chronik.e.cash` does not expose the `agora` plugin.
- `agora.historicOffers({ type: "TOKEN_ID" })` is sufficient to reconstruct normalized `TAKEN` and `CANCELED` offers.
- For `PARTIAL` offers, price cannot be computed from `offer.askedSats()` alone. It must use `offer.takenInfo.atoms`.
- Raw plugin history retains spend-tx metadata like `txid`, `block.height`, and `block.timestamp`, which `historicOffers()` does not expose directly.
- Active group discovery on the validated node returns `F` prefixed groups (`46...`) on the first page. This is why discovery and historical parsing should be treated as separate concerns.
- For online sync, the correct unique key is the spent offer outpoint: `offer_txid + offer_out_idx`.

## Proposed pipeline

1. Discovery:
   - Enumerate active token ids from Agora plugin groups with `F` and `G` prefixes.
   - Seed `tracked_tokens`.
   - Accept that historical-only tokens still need a second discovery source or a deeper chain scan.
2. Backfill:
   - For each token, fetch raw `plugin.history(54 + tokenId)` and normalized `agora.historicOffers()` for the same page.
   - Join them by the spent offer outpoint.
   - Persist only taken trades into `processed_trades`.
3. Aggregation:
   - Increment `token_stats` only for newly inserted trades.
4. Live sync:
   - WebSocket marks token ids dirty.
   - Dirty tokens get tail-synced over the newest N pages.
   - Active token discovery still runs on a low-frequency interval to find newly listed tokens.
5. Reorg safety:
   - Keep minimal trade rows with spend tx metadata.
   - Reorg repair is still a future iteration.

## Core entities

- `tracked_tokens`
- `processed_trades`
- `token_stats`
- `dirty_token_queue` in memory

## Questions to answer in the first implementation

- How do we discover historical-only tokens that no longer have active Agora groups?
- How much tail depth is enough for high-volume tokens in practice?
- Do we want to persist more raw tx context for reorg repair and audits?
