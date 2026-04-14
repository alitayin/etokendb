export interface ServerCliOptions {
  deferKnownTradeCountLte: number | null;
}

export function parseServerCliOptions(argv: string[]): ServerCliOptions {
  let deferKnownTradeCountLte: number | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    if (arg === "--skip-known-zero-trade-bootstrap") {
      deferKnownTradeCountLte = 0;
      continue;
    }

    if (arg.startsWith("--defer-known-trade-count-lte=")) {
      const rawValue = arg.slice("--defer-known-trade-count-lte=".length);
      deferKnownTradeCountLte = parseNonNegativeInt(rawValue, arg);
      continue;
    }

    if (arg === "--defer-known-trade-count-lte") {
      const rawValue = argv[index + 1];
      if (rawValue === undefined) {
        throw new Error(`Missing value for ${arg}`);
      }
      deferKnownTradeCountLte = parseNonNegativeInt(rawValue, arg);
      index += 1;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      throw new Error(
        [
          "Usage:",
          "  tsx src/cli/server.ts",
          "  tsx src/cli/server.ts --skip-known-zero-trade-bootstrap",
          "  tsx src/cli/server.ts --defer-known-trade-count-lte 1",
        ].join("\n"),
      );
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    deferKnownTradeCountLte,
  };
}

function parseNonNegativeInt(rawValue: string, argName: string): number {
  const value = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${argName} must be a non-negative integer, got: ${rawValue}`);
  }
  return value;
}
