/**
 * @file TokenGraph.ts
 * @description Constructs and maintains a directed multigraph of token swap routes from the pool
 *              registry. Nodes are token addresses. Edges are pool routes with associated DEX adapter,
 *              pool address, and edge weight. Provides adjacency list access for path algorithms.
 */

import { DexId, DEX_NAMES, ProtocolVersion } from '../config/constants';
import { pairKey } from '../utils/addressUtils';
import { getAmountOut as v2GetAmountOut } from '../dex/math/V2Math';
import { createModuleLogger } from '../utils/logger';
import type { PoolRegistry, PoolEntry } from '../discovery/types';
import type { GraphEdge } from './types';

const logger = createModuleLogger('TokenGraph');

export class TokenGraph {
  // Adjacency list: token -> list of outgoing edges
  private adjacency: Map<string, GraphEdge[]>;
  // All edges indexed by pool address
  private edgesByPool: Map<string, GraphEdge[]>;
  // Pool index by pair key
  private poolsByPair: Map<string, PoolEntry[]>;
  // All unique tokens
  private tokens: Set<string>;

  constructor() {
    this.adjacency = new Map();
    this.edgesByPool = new Map();
    this.poolsByPair = new Map();
    this.tokens = new Set();
  }

  /**
   * Builds the graph from a pool registry.
   */
  buildFromRegistry(registry: PoolRegistry): void {
    const startTime = Date.now();
    this.clear();

    for (const [, pool] of Object.entries(registry.pools)) {
      this._addPoolEdges(pool);
    }

    logger.info('Token graph built', {
      tokens: this.tokens.size,
      totalEdges: this._countEdges(),
      pools: Object.keys(registry.pools).length,
      buildTimeMs: Date.now() - startTime,
    });
  }

  /**
   * Updates the graph with new or modified pools without full rebuild.
   */
  updateFromRegistry(registry: PoolRegistry): void {
    for (const [, pool] of Object.entries(registry.pools)) {
      const poolKey = pool.address.toLowerCase();
      // Remove old edges for this pool
      this._removePoolEdges(poolKey);
      // Add updated edges
      this._addPoolEdges(pool);
    }
  }

  /**
   * Returns all outgoing edges from a token.
   */
  getEdgesFrom(token: string): GraphEdge[] {
    return this.adjacency.get(token.toLowerCase()) || [];
  }

  /**
   * Returns all edges between two tokens (in one direction).
   */
  getEdgesBetween(from: string, to: string): GraphEdge[] {
    const edges = this.getEdgesFrom(from);
    return edges.filter((e) => e.to === to.toLowerCase());
  }

  /**
   * Returns all pools for a given token pair (regardless of direction).
   */
  getPoolsForPair(tokenA: string, tokenB: string): PoolEntry[] {
    const key = pairKey(tokenA, tokenB);
    return this.poolsByPair.get(key) || [];
  }

  /**
   * Returns all unique token addresses in the graph.
   */
  getTokens(): string[] {
    return Array.from(this.tokens);
  }

  /**
   * Returns the number of unique tokens.
   */
  getTokenCount(): number {
    return this.tokens.size;
  }

  /**
   * Returns the total number of directed edges.
   */
  getEdgeCount(): number {
    return this._countEdges();
  }

  /**
   * Returns all neighbors (directly reachable tokens) from a token.
   */
  getNeighbors(token: string): string[] {
    const edges = this.getEdgesFrom(token);
    const neighbors = new Set<string>();
    for (const edge of edges) {
      neighbors.add(edge.to);
    }
    return Array.from(neighbors);
  }

  /**
   * Checks if a token exists in the graph.
   */
  hasToken(token: string): boolean {
    return this.tokens.has(token.toLowerCase());
  }

  /**
   * Clears the entire graph.
   */
  clear(): void {
    this.adjacency.clear();
    this.edgesByPool.clear();
    this.poolsByPair.clear();
    this.tokens.clear();
  }

  /**
   * Adds bidirectional edges for a pool.
   */
  private _addPoolEdges(pool: PoolEntry): void {
    const t0 = pool.token0.address.toLowerCase();
    const t1 = pool.token1.address.toLowerCase();

    this.tokens.add(t0);
    this.tokens.add(t1);

    // Index by pair
    const pk = pairKey(t0, t1);
    if (!this.poolsByPair.has(pk)) {
      this.poolsByPair.set(pk, []);
    }
    this.poolsByPair.get(pk)!.push(pool);

    // Compute edge weights
    const dexId = this._getDexIdFromName(pool.dex);
    const fee = pool.fee ?? 30;

    // Forward edge: token0 -> token1
    const forwardWeight = this._computeEdgeWeight(pool, true);
    const forwardEdge: GraphEdge = {
      from: t0,
      to: t1,
      poolAddress: pool.address,
      dexId,
      dexName: pool.dex,
      fee,
      weight: forwardWeight,
      reserve0: pool.reserve0 ? BigInt(pool.reserve0) : undefined,
      reserve1: pool.reserve1 ? BigInt(pool.reserve1) : undefined,
      sqrtPriceX96: pool.sqrtPriceX96 ? BigInt(pool.sqrtPriceX96) : undefined,
      liquidity: pool.liquidity ? BigInt(pool.liquidity) : undefined,
      tick: pool.tick ?? undefined,
      stable: pool.stable,
      tickSpacing: pool.tickSpacing,
    };

    // Reverse edge: token1 -> token0
    const reverseWeight = this._computeEdgeWeight(pool, false);
    const reverseEdge: GraphEdge = {
      ...forwardEdge,
      from: t1,
      to: t0,
      weight: reverseWeight,
    };

    this._addEdge(forwardEdge);
    this._addEdge(reverseEdge);

    // Index by pool
    const poolKey = pool.address.toLowerCase();
    this.edgesByPool.set(poolKey, [forwardEdge, reverseEdge]);
  }

  /**
   * Adds a single directed edge to the adjacency list.
   */
  private _addEdge(edge: GraphEdge): void {
    if (!this.adjacency.has(edge.from)) {
      this.adjacency.set(edge.from, []);
    }
    this.adjacency.get(edge.from)!.push(edge);
  }

  /**
   * Removes all edges associated with a pool.
   */
  private _removePoolEdges(poolAddress: string): void {
    const edges = this.edgesByPool.get(poolAddress);
    if (!edges) return;

    for (const edge of edges) {
      const fromEdges = this.adjacency.get(edge.from);
      if (fromEdges) {
        const idx = fromEdges.findIndex((e) => e.poolAddress.toLowerCase() === poolAddress);
        if (idx !== -1) fromEdges.splice(idx, 1);
      }
    }

    this.edgesByPool.delete(poolAddress);
  }

  /**
   * Computes the log-transformed edge weight for Bellman-Ford.
   * Weight = -log(outputRatio) where outputRatio = amountOut / amountIn.
   * Negative weight cycles correspond to profitable arbitrage.
   */
  private _computeEdgeWeight(pool: PoolEntry, zeroForOne: boolean): number {
    try {
      if (pool.version === ProtocolVersion.V2 || pool.reserve0) {
        const r0 = BigInt(pool.reserve0 || '0');
        const r1 = BigInt(pool.reserve1 || '0');
        if (r0 === 0n || r1 === 0n) return Infinity;

        const reserveIn = zeroForOne ? r0 : r1;
        const reserveOut = zeroForOne ? r1 : r0;
        const feeBps = pool.fee ?? 30;

        // Use a reference amount (1e18) to compute the exchange rate
        const refAmount = 10n ** 18n;
        const amountOut = v2GetAmountOut(refAmount, reserveIn, reserveOut, feeBps);
        if (amountOut === 0n) return Infinity;

        const ratio = Number(amountOut) / Number(refAmount);
        return -Math.log(ratio);
      }

      if (pool.sqrtPriceX96) {
        const sqrtPrice = BigInt(pool.sqrtPriceX96);
        if (sqrtPrice === 0n) return Infinity;

        // price = (sqrtPriceX96 / 2^96)^2 = token1/token0
        const priceNum = Number(sqrtPrice) / 2 ** 96;
        const price = priceNum * priceNum;

        if (price === 0 || !isFinite(price)) return Infinity;

        const feePips = pool.fee ?? 3000;
        const feeMultiplier = 1 - feePips / 1000000;

        const ratio = zeroForOne ? price * feeMultiplier : (1 / price) * feeMultiplier;
        if (ratio <= 0 || !isFinite(ratio)) return Infinity;

        return -Math.log(ratio);
      }

      return Infinity;
    } catch {
      return Infinity;
    }
  }

  /**
   * Maps a DEX name string to its numeric DexId.
   */
  private _getDexIdFromName(dexName: string): number {
    for (const [id, name] of Object.entries(DEX_NAMES)) {
      if (name === dexName) return Number(id);
    }
    return 0;
  }

  /**
   * Counts total directed edges in the graph.
   */
  private _countEdges(): number {
    let count = 0;
    for (const edges of this.adjacency.values()) {
      count += edges.length;
    }
    return count;
  }
}