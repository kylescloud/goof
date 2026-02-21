/**
 * @file BellmanFord.ts
 * @description Implements the Bellman-Ford shortest path algorithm on the token graph with
 *              negative edge weights. Detects negative-weight cycles which correspond to
 *              profitable arbitrage loops. Returns all detected cycles with their constituent
 *              edges and estimated cycle profit multiplier.
 */

import { createModuleLogger } from '../utils/logger';
import type { TokenGraph } from './TokenGraph';
import type { GraphEdge, ArbitrageCycle } from './types';

const logger = createModuleLogger('BellmanFord');

export class BellmanFord {
  private graph: TokenGraph;

  constructor(graph: TokenGraph) {
    this.graph = graph;
  }

  /**
   * Runs Bellman-Ford from a source token and detects negative-weight cycles.
   * @param sourceToken The starting token address.
   * @returns Array of detected arbitrage cycles.
   */
  findNegativeCycles(sourceToken: string): ArbitrageCycle[] {
    const source = sourceToken.toLowerCase();
    const tokens = this.graph.getTokens();

    if (!this.graph.hasToken(source)) return [];

    // Initialize distances and predecessors
    const dist: Map<string, number> = new Map();
    const pred: Map<string, { edge: GraphEdge; prevToken: string } | null> = new Map();

    for (const token of tokens) {
      dist.set(token, Infinity);
      pred.set(token, null);
    }
    dist.set(source, 0);

    const n = tokens.length;

    // Relax edges n-1 times
    for (let i = 0; i < n - 1; i++) {
      let updated = false;

      for (const u of tokens) {
        const dU = dist.get(u)!;
        if (dU === Infinity) continue;

        const edges = this.graph.getEdgesFrom(u);
        for (const edge of edges) {
          const newDist = dU + edge.weight;
          const currentDist = dist.get(edge.to) ?? Infinity;

          if (newDist < currentDist) {
            dist.set(edge.to, newDist);
            pred.set(edge.to, { edge, prevToken: u });
            updated = true;
          }
        }
      }

      // Early termination if no updates
      if (!updated) break;
    }

    // Detect negative cycles (one more relaxation pass)
    const negativeCycleTokens = new Set<string>();

    for (const u of tokens) {
      const dU = dist.get(u)!;
      if (dU === Infinity) continue;

      const edges = this.graph.getEdgesFrom(u);
      for (const edge of edges) {
        const newDist = dU + edge.weight;
        const currentDist = dist.get(edge.to) ?? Infinity;

        if (newDist < currentDist) {
          negativeCycleTokens.add(edge.to);
        }
      }
    }

    if (negativeCycleTokens.size === 0) return [];

    // Extract cycles
    const cycles: ArbitrageCycle[] = [];
    const visited = new Set<string>();

    for (const cycleToken of negativeCycleTokens) {
      if (visited.has(cycleToken)) continue;

      const cycle = this._extractCycle(cycleToken, pred, visited);
      if (cycle) {
        cycles.push(cycle);
      }
    }

    logger.debug('Bellman-Ford complete', {
      source,
      negativeCyclesFound: cycles.length,
    });

    return cycles;
  }

  /**
   * Runs Bellman-Ford from all Aave-eligible tokens and collects all negative cycles.
   * @param aaveTokens Array of Aave flash-loanable token addresses.
   * @returns Deduplicated array of arbitrage cycles.
   */
  findAllNegativeCycles(aaveTokens: string[]): ArbitrageCycle[] {
    const allCycles: ArbitrageCycle[] = [];
    const seenCycleKeys = new Set<string>();

    for (const token of aaveTokens) {
      const cycles = this.findNegativeCycles(token);

      for (const cycle of cycles) {
        const key = this._cycleKey(cycle);
        if (!seenCycleKeys.has(key)) {
          seenCycleKeys.add(key);
          allCycles.push(cycle);
        }
      }
    }

    logger.info('All negative cycles found', { totalCycles: allCycles.length });
    return allCycles;
  }

  /**
   * Extracts a cycle from the predecessor map starting from a token in a negative cycle.
   */
  private _extractCycle(
    startToken: string,
    pred: Map<string, { edge: GraphEdge; prevToken: string } | null>,
    globalVisited: Set<string>
  ): ArbitrageCycle | null {
    // Walk back through predecessors to find the cycle
    let current = startToken;
    const visited = new Set<string>();

    // Walk back n steps to ensure we're in the cycle
    const n = pred.size;
    for (let i = 0; i < n; i++) {
      const p = pred.get(current);
      if (!p) return null;
      current = p.prevToken;
    }

    // Now current is definitely in the cycle. Walk until we return to current.
    const cycleStart = current;
    const edges: GraphEdge[] = [];
    let node = cycleStart;

    do {
      const p = pred.get(node);
      if (!p) return null;

      edges.unshift(p.edge);
      visited.add(node);
      globalVisited.add(node);
      node = p.prevToken;

      // Safety: prevent infinite loops
      if (edges.length > 10) return null;
    } while (node !== cycleStart);

    if (edges.length < 2 || edges.length > 6) return null;

    // Calculate profit multiplier: product of exchange rates around the cycle
    const profitMultiplier = this._calculateProfitMultiplier(edges);
    const estimatedProfitBps = Math.round((profitMultiplier - 1) * 10000);

    if (estimatedProfitBps <= 0) return null;

    return {
      edges,
      profitMultiplier,
      estimatedProfitBps,
      startToken: cycleStart,
    };
  }

  /**
   * Calculates the profit multiplier for a cycle.
   * profitMultiplier = exp(-sum(weights))
   */
  private _calculateProfitMultiplier(edges: GraphEdge[]): number {
    let totalWeight = 0;
    for (const edge of edges) {
      if (!isFinite(edge.weight)) return 0;
      totalWeight += edge.weight;
    }
    return Math.exp(-totalWeight);
  }

  /**
   * Creates a unique key for a cycle (for deduplication).
   */
  private _cycleKey(cycle: ArbitrageCycle): string {
    const poolAddresses = cycle.edges.map((e) => e.poolAddress.toLowerCase()).sort();
    return poolAddresses.join('-');
  }
}