/**
 * @file BeamSearch.ts
 * @description Beam search algorithm for path pruning. At each hop, retains only the top
 *              beamWidth candidate partial paths ranked by current accumulated expected profit.
 *              Drastically reduces the combinatorial explosion of path enumeration.
 */

import { createModuleLogger } from '../utils/logger';
import type { TokenGraph } from './TokenGraph';
import type { GraphEdge, PathCandidate } from './types';

const logger = createModuleLogger('BeamSearch');

export class BeamSearch {
  private graph: TokenGraph;
  private beamWidth: number;
  private maxHops: number;

  constructor(graph: TokenGraph, beamWidth: number = 20, maxHops: number = 4) {
    this.graph = graph;
    this.beamWidth = beamWidth;
    this.maxHops = maxHops;
  }

  /**
   * Performs beam search to find the most profitable cyclic paths from a start token.
   * @param startToken The token to start and end at.
   * @param maxResults Maximum number of complete paths to return.
   * @returns Array of edge arrays representing the best cyclic paths found.
   */
  search(startToken: string, maxResults: number = 50): GraphEdge[][] {
    const start = startToken.toLowerCase();
    if (!this.graph.hasToken(start)) return [];

    const completePaths: GraphEdge[][] = [];

    // Initialize beam with edges from start token
    let beam: PathCandidate[] = [];
    const startEdges = this.graph.getEdgesFrom(start);

    for (const edge of startEdges) {
      if (edge.weight === Infinity) continue;

      beam.push({
        edges: [edge],
        accumulatedWeight: edge.weight,
        currentToken: edge.to,
        visitedTokens: new Set([start, edge.to]),
      });
    }

    // Sort and prune initial beam
    beam = this._pruneBeam(beam);

    // Expand beam for each hop
    for (let hop = 1; hop < this.maxHops; hop++) {
      const nextBeam: PathCandidate[] = [];

      for (const candidate of beam) {
        const edges = this.graph.getEdgesFrom(candidate.currentToken);

        for (const edge of edges) {
          if (edge.weight === Infinity) continue;

          // Check if this edge completes a cycle back to start
          if (edge.to === start) {
            const completePath = [...candidate.edges, edge];
            completePaths.push(completePath);

            if (completePaths.length >= maxResults) {
              return this._sortPathsByProfit(completePaths).slice(0, maxResults);
            }
            continue;
          }

          // Skip if already visited (no revisiting tokens)
          if (candidate.visitedTokens.has(edge.to)) continue;

          // Create new candidate
          const newVisited = new Set(candidate.visitedTokens);
          newVisited.add(edge.to);

          nextBeam.push({
            edges: [...candidate.edges, edge],
            accumulatedWeight: candidate.accumulatedWeight + edge.weight,
            currentToken: edge.to,
            visitedTokens: newVisited,
          });
        }
      }

      // Prune to beam width
      beam = this._pruneBeam(nextBeam);

      if (beam.length === 0) break;
    }

    // Also check if any remaining beam candidates can close the cycle
    for (const candidate of beam) {
      const edges = this.graph.getEdgesFrom(candidate.currentToken);
      for (const edge of edges) {
        if (edge.to === start && edge.weight !== Infinity) {
          completePaths.push([...candidate.edges, edge]);
        }
      }
    }

    const sorted = this._sortPathsByProfit(completePaths);

    logger.debug('Beam search complete', {
      startToken: start,
      pathsFound: sorted.length,
      beamWidth: this.beamWidth,
      maxHops: this.maxHops,
    });

    return sorted.slice(0, maxResults);
  }

  /**
   * Performs beam search for paths between two different tokens.
   * @param fromToken Source token.
   * @param toToken Destination token.
   * @param maxResults Maximum results.
   * @returns Array of edge arrays.
   */
  searchDirected(fromToken: string, toToken: string, maxResults: number = 20): GraphEdge[][] {
    const from = fromToken.toLowerCase();
    const to = toToken.toLowerCase();

    if (!this.graph.hasToken(from) || !this.graph.hasToken(to)) return [];

    const completePaths: GraphEdge[][] = [];
    let beam: PathCandidate[] = [];

    const startEdges = this.graph.getEdgesFrom(from);
    for (const edge of startEdges) {
      if (edge.weight === Infinity) continue;

      if (edge.to === to) {
        completePaths.push([edge]);
        continue;
      }

      beam.push({
        edges: [edge],
        accumulatedWeight: edge.weight,
        currentToken: edge.to,
        visitedTokens: new Set([from, edge.to]),
      });
    }

    beam = this._pruneBeam(beam);

    for (let hop = 1; hop < this.maxHops; hop++) {
      const nextBeam: PathCandidate[] = [];

      for (const candidate of beam) {
        const edges = this.graph.getEdgesFrom(candidate.currentToken);

        for (const edge of edges) {
          if (edge.weight === Infinity) continue;

          if (edge.to === to) {
            completePaths.push([...candidate.edges, edge]);
            if (completePaths.length >= maxResults) {
              return this._sortPathsByProfit(completePaths).slice(0, maxResults);
            }
            continue;
          }

          if (candidate.visitedTokens.has(edge.to)) continue;

          const newVisited = new Set(candidate.visitedTokens);
          newVisited.add(edge.to);

          nextBeam.push({
            edges: [...candidate.edges, edge],
            accumulatedWeight: candidate.accumulatedWeight + edge.weight,
            currentToken: edge.to,
            visitedTokens: newVisited,
          });
        }
      }

      beam = this._pruneBeam(nextBeam);
      if (beam.length === 0) break;
    }

    return this._sortPathsByProfit(completePaths).slice(0, maxResults);
  }

  /**
   * Prunes the beam to retain only the top beamWidth candidates.
   * Lower accumulated weight = better (more negative = more profitable).
   */
  private _pruneBeam(candidates: PathCandidate[]): PathCandidate[] {
    if (candidates.length <= this.beamWidth) return candidates;

    candidates.sort((a, b) => a.accumulatedWeight - b.accumulatedWeight);
    return candidates.slice(0, this.beamWidth);
  }

  /**
   * Sorts complete paths by estimated profit (most profitable first).
   */
  private _sortPathsByProfit(paths: GraphEdge[][]): GraphEdge[][] {
    return paths.sort((a, b) => {
      const weightA = a.reduce((sum, e) => sum + e.weight, 0);
      const weightB = b.reduce((sum, e) => sum + e.weight, 0);
      return weightA - weightB; // More negative = more profitable
    });
  }

  /**
   * Updates beam width.
   */
  setBeamWidth(width: number): void {
    this.beamWidth = width;
  }

  /**
   * Updates max hops.
   */
  setMaxHops(hops: number): void {
    this.maxHops = hops;
  }
}