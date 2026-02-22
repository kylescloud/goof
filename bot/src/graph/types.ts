/**
 * @file graph/types.ts
 * @description Type definitions for the graph module.
 */

export interface GraphEdge {
  from: string;           // Token address (source)
  to: string;             // Token address (destination)
  poolAddress: string;    // Pool contract address
  dexId: number;          // DEX identifier
  dexName: string;        // DEX name
  fee: number;            // Fee in ppm (e.g. 3000 = 0.3%, 500 = 0.05%)
  weight: number;         // Log-transformed weight for Bellman-Ford
  reserve0?: bigint;      // V2 reserve of token0
  reserve1?: bigint;      // V2 reserve of token1
  sqrtPriceX96?: bigint;  // V3 sqrt price
  liquidity?: bigint;     // V3 liquidity or TVL indicator
  tick?: number;          // V3 current tick
  stable?: boolean;       // Aerodrome Classic: stable pool flag
  tickSpacing?: number;   // Aerodrome Slipstream: tick spacing
}

export interface ArbitrageCycle {
  edges: GraphEdge[];
  profitMultiplier: number;  // Product of exchange rates around the cycle
  estimatedProfitBps: number;
  startToken: string;
}

export interface ArbitragePath {
  id: string;
  edges: GraphEdge[];
  flashAsset: string;
  flashAmount: bigint;
  expectedInputAmount: bigint;
  expectedOutputAmount: bigint;
  expectedGrossProfitUsd: number;
  estimatedGasCostUsd: number;
  estimatedNetProfitUsd: number;
  hops: number;
  strategy: string;
  timestamp: number;
}

export interface PathCandidate {
  edges: GraphEdge[];
  accumulatedWeight: number;
  currentToken: string;
  visitedTokens: Set<string>;
}