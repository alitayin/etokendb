export interface ServerCliOptions {
  skipKnownZeroTradeBootstrap: boolean;
}

export function parseServerCliOptions(argv: string[]): ServerCliOptions {
  let skipKnownZeroTradeBootstrap = false;

  for (const arg of argv) {
    if (arg === "--skip-known-zero-trade-bootstrap") {
      skipKnownZeroTradeBootstrap = true;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      throw new Error(
        [
          "Usage:",
          "  tsx src/cli/server.ts",
          "  tsx src/cli/server.ts --skip-known-zero-trade-bootstrap",
        ].join("\n"),
      );
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    skipKnownZeroTradeBootstrap,
  };
}
