/**
 * @file DexAdapterRegistry.ts
 * @description Maintains a registry of all IDexAdapter implementations keyed by DEX ID.
 *              Used by the StrategyEngine and TransactionBuilder to get the correct adapter
 *              for a given pool or swap step.
 */

import { ethers } from 'ethers';
import { DexId } from '../config/constants';
import { DEX_ADDRESSES, DEX_FACTORY_DEPLOY_BLOCKS } from '../config/addresses';
import type { IDexAdapter, DexConfig } from './types';
import { UniswapV2Adapter } from './adapters/UniswapV2Adapter';
import { UniswapV3Adapter } from './adapters/UniswapV3Adapter';
import { SushiswapV2Adapter } from './adapters/SushiswapV2Adapter';
import { SushiswapV3Adapter } from './adapters/SushiswapV3Adapter';
import { AerodromeAdapter } from './adapters/AerodromeAdapter';
import { AerodromeSlipstreamAdapter } from './adapters/AerodromeSlipstreamAdapter';
import { BaseswapV2Adapter } from './adapters/BaseswapV2Adapter';
import { BaseswapV3Adapter } from './adapters/BaseswapV3Adapter';
import { SwapBasedAdapter } from './adapters/SwapBasedAdapter';
import { PancakeswapV3Adapter } from './adapters/PancakeswapV3Adapter';
import { createModuleLogger } from '../utils/logger';

const logger = createModuleLogger('DexAdapterRegistry');

export class DexAdapterRegistry {
  private adapters: Map<DexId, IDexAdapter>;
  private configs: Map<DexId, DexConfig>;

  constructor() {
    this.adapters = new Map();
    this.configs = new Map();
  }

  /**
   * Initializes all DEX adapters with the given provider.
   */
  initialize(provider: ethers.Provider): void {
    logger.info('Initializing DEX adapter registry');

    // Uniswap V2
    this.register(
      DexId.UNISWAP_V2,
      new UniswapV2Adapter(provider, DEX_ADDRESSES.uniswapV2.factory, DEX_ADDRESSES.uniswapV2.router)
    );

    // Uniswap V3
    this.register(
      DexId.UNISWAP_V3,
      new UniswapV3Adapter(
        provider,
        DEX_ADDRESSES.uniswapV3.factory,
        DEX_ADDRESSES.uniswapV3.router,
        DEX_ADDRESSES.uniswapV3.quoter!
      )
    );

    // SushiSwap V2
    this.register(
      DexId.SUSHISWAP_V2,
      new SushiswapV2Adapter(provider, DEX_ADDRESSES.sushiswapV2.factory, DEX_ADDRESSES.sushiswapV2.router)
    );

    // SushiSwap V3
    this.register(
      DexId.SUSHISWAP_V3,
      new SushiswapV3Adapter(
        provider,
        DEX_ADDRESSES.sushiswapV3.factory,
        DEX_ADDRESSES.sushiswapV3.router,
        DEX_ADDRESSES.sushiswapV3.quoter!
      )
    );

    // Aerodrome
    this.register(
      DexId.AERODROME,
      new AerodromeAdapter(provider, DEX_ADDRESSES.aerodrome.factory, DEX_ADDRESSES.aerodrome.router)
    );

    // Aerodrome Slipstream
    this.register(
      DexId.AERODROME_SLIPSTREAM,
      new AerodromeSlipstreamAdapter(
        provider,
        DEX_ADDRESSES.aerodromeSlipstream.factory,
        DEX_ADDRESSES.aerodromeSlipstream.router,
        DEX_ADDRESSES.aerodromeSlipstream.quoter!
      )
    );

    // BaseSwap V2
    this.register(
      DexId.BASESWAP_V2,
      new BaseswapV2Adapter(provider, DEX_ADDRESSES.baseswapV2.factory, DEX_ADDRESSES.baseswapV2.router)
    );

    // BaseSwap V3
    this.register(
      DexId.BASESWAP_V3,
      new BaseswapV3Adapter(
        provider,
        DEX_ADDRESSES.baseswapV3.factory,
        DEX_ADDRESSES.baseswapV3.router,
        DEX_ADDRESSES.baseswapV3.quoter!
      )
    );

    // SwapBased
    this.register(
      DexId.SWAPBASED,
      new SwapBasedAdapter(provider, DEX_ADDRESSES.swapBased.factory, DEX_ADDRESSES.swapBased.router)
    );

    // PancakeSwap V3
    this.register(
      DexId.PANCAKESWAP_V3,
      new PancakeswapV3Adapter(
        provider,
        DEX_ADDRESSES.pancakeswapV3.factory,
        DEX_ADDRESSES.pancakeswapV3.router,
        DEX_ADDRESSES.pancakeswapV3.quoter!
      )
    );

    logger.info('DEX adapter registry initialized', { adapterCount: this.adapters.size });
  }

  /**
   * Registers a DEX adapter.
   */
  register(dexId: DexId, adapter: IDexAdapter): void {
    this.adapters.set(dexId, adapter);
    logger.debug('Registered DEX adapter', { dexId, name: adapter.name });
  }

  /**
   * Gets a DEX adapter by ID.
   * @throws If the adapter is not registered.
   */
  getAdapter(dexId: DexId): IDexAdapter {
    const adapter = this.adapters.get(dexId);
    if (!adapter) {
      throw new Error(`DEX adapter not found for dexId: ${dexId}`);
    }
    return adapter;
  }

  /**
   * Gets a DEX adapter by ID, or undefined if not registered.
   */
  getAdapterOrNull(dexId: DexId): IDexAdapter | undefined {
    return this.adapters.get(dexId);
  }

  /**
   * Returns all registered adapters.
   */
  getAllAdapters(): IDexAdapter[] {
    return Array.from(this.adapters.values());
  }

  /**
   * Returns all registered DEX IDs.
   */
  getAllDexIds(): DexId[] {
    return Array.from(this.adapters.keys());
  }

  /**
   * Returns the number of registered adapters.
   */
  get size(): number {
    return this.adapters.size;
  }

  /**
   * Updates the provider for all adapters.
   */
  updateProvider(provider: ethers.Provider): void {
    for (const adapter of this.adapters.values()) {
      if ('updateProvider' in adapter && typeof adapter.updateProvider === 'function') {
        (adapter as { updateProvider: (p: ethers.Provider) => void }).updateProvider(provider);
      }
    }
  }
}