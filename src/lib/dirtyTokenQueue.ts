export class DirtyTokenQueue {
  private readonly pending = new Set<string>();
  private readonly inFlight = new Set<string>();
  private readonly rerun = new Set<string>();

  markDirty(tokenId: string): void {
    if (this.inFlight.has(tokenId)) {
      this.rerun.add(tokenId);
      return;
    }

    this.pending.add(tokenId);
  }

  hasPending(): boolean {
    return this.pending.size > 0;
  }

  pendingCount(): number {
    return this.pending.size;
  }

  takeNext(limit = 1): string[] {
    const batch: string[] = [];
    for (const tokenId of this.pending) {
      this.pending.delete(tokenId);
      this.inFlight.add(tokenId);
      batch.push(tokenId);
      if (batch.length >= limit) {
        break;
      }
    }
    return batch;
  }

  markCompleted(tokenId: string): void {
    this.inFlight.delete(tokenId);
    if (this.rerun.delete(tokenId)) {
      this.pending.add(tokenId);
    }
  }
}
