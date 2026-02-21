/**
 * @file PathEnumerator.ts
 * @description DFS-based path enumeration. Given a start token, enumerates all simple paths
 *              back to the start token up to maxHops depth. Uses cycle detection to avoid
 *              revisiting nodes. Returns paths as ordered lists of graph edges.
 */

import { createModuleLogger } from '../utils/logger';
import type { TokenGraph } from './TokenGraph';
import type { GraphEdge, PathCandidate } from './types';

const logger = createModuleLogger('PathEnumerator');

export class PathEnumerator {
  private graph: TokenGraph;
  private maxHops: number;

  constructor(graph: TokenGraph, maxHops: number = 4) {
    this.graph = graph;
    this.maxHops = maxHops;
  }

  /**
   * Enumerates all simple cyclic paths starting and ending at the given token.
   * @param startToken The token to start and end at.
   * @param maxResults Maximum number of paths to return.
   * @returns Array of edge arrays representing cyclic paths.
   */
  enumerateCyclicPaths(startToken: string, maxResults: number = 1000): GraphEdge[][] {
    const start = startToken.toLowerCase();
    if (!this.graph.hasToken(start)) return [];

    const paths: GraphEdge[][] = [];
    const visited = new Set<string>();
    visited.add(start);

    this._dfs(start, start, [], visited, paths, maxResults);

    logger.debug('Path enumeration complete', {
      startToken: start,
      pathsFound: paths.length,
      maxHops: this.maxHops,
    });

    return paths;
  }

  /**
   * Enumerates paths between two different tokens.
   * @param fromToken The source token.
   * @param toToken The destination token.
   * @param maxResults Maximum number of paths to return.
   * @returns Array of edge arrays representing paths.
   */
  enumerateDirectPaths(fromToken: string, toToken: string, maxResults: number = 100): GraphEdge[][] {
    const from = fromToken.toLowerCase();
    const to = toToken.toLowerCase();

    if (!this.graph.hasToken(from) || !this.graph.hasToken(to)) return [];

    const paths: GraphEdge[][] = [];
    const visited = new Set<string>();
    visited.add(from);

    this._dfsDirected(from, to, [], visited, paths, maxResults);

    return paths;
  }

  /**
   * DFS for cyclic paths (start == end).
   */
  private _dfs(
    current: string,
    target: string,
    currentPath: GraphEdge[],
    visited: Set<string>,
    results: GraphEdge[][],
    maxResults: number
  ): void {
    if (results.length >= maxResults) return;

    const edges = this.graph.getEdgesFrom(current);

    for (const edge of edges) {
      if (edge.weight === Infinity) continue;

      // Found a cycle back to start (minimum 2 hops)
      if (edge.to === target && currentPath.length >= 1) {
        results.push([...currentPath, edge]);
        if (results.length >= maxResults) return;
        continue;
      }

      // Continue DFS if within hop limit and not visited
      if (currentPath.length < this.maxHops - 1 && !visited.has(edge.to)) {
        visited.add(edge.to);
        currentPath.push(edge);

        this._dfs(edge.to, target, currentPath, visited, results, maxResults);

        currentPath.pop();
        visited.delete(edge.to);

        if (results.length >= maxResults) return;
      }
    }
  }

  /**
   * DFS for directed paths (from != to).
   */
  private _dfsDirected(
    current: string,
    target: string,
    currentPath: GraphEdge[],
    visited: Set<string>,
    results: GraphEdge[][],
    maxResults: number
  ): void {
    if (results.length >= maxResults) return;

    const edges = this.graph.getEdgesFrom(current);

    for (const edge of edges) {
      if (edge.weight === Infinity) continue;

      if (edge.to === target) {
        results.push([...currentPath, edge]);
        if (results.length >= maxResults) return;
        continue;
      }

      if (currentPath.length < this.maxHops - 1 && !visited.has(edge.to)) {
        visited.add(edge.to);
        currentPath.push(edge);

        this._dfsDirected(edge.to, target, currentPath, visited, results, maxResults);

        currentPath.pop();
        visited.delete(edge.to);

        if (results.length >= maxResults) return;
      }
    }
  }

  /**
   * Updates the maximum hop count.
   */
  setMaxHops(maxHops: number): void {
    this.maxHops = maxHops;
  }
}