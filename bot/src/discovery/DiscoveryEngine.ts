/**
 * @file DiscoveryEngine.ts
 * @description Orchestrates the full pool discovery lifecycle. On initialization, runs a full
 *              discovery cycle using PoolIndexer, then schedules incremental updates via
 *              IncrementalUpdater on the configured cron schedule. Emits poolsUpdated events.
 */

import { ethers } from 'ethers';
import { EventEmitter } from 'events';
import cron from 'node-cron';
import { type Config } from '../config';
import { MulticallBatcher } from '../multicall/MulticallBatcher';
import { AaveAssetFetcher } from './AaveAssetFetcher';
import { PoolIndexer } from './PoolIndexer';
import { PoolRegistryWriter } from './PoolRegistryWriter';
import { IncrementalUpdater } from './IncrementalUpdater';
import { createModuleLogger } from '../utils/logger';
import type { PoolRegistry, DiscoveryResult, RawPoolData } from './types';
import { ProtocolVersion } from '../config/constants';

const logger = createModuleLogger('DiscoveryEngine');

// ═══════════════════════════════════════════════════════════════════════════════
// Token address constants (checksummed) for readability
// ═══════════════════════════════════════════════════════════════════════════════
const T = {
  WETH:   '0x4200000000000000000000000000000000000006',
  USDC:   '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  USDbC:  '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA',
  DAI:    '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb',
  USDT:   '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2',
  cbETH:  '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22',
  wstETH: '0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452',
  rETH:   '0xB6fe221Fe9EeF5aBa221c348bA20A1Bf5e73624c',
  cbBTC:  '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf',
  weETH:  '0x04C0599Ae5A44757c0af6F9eC3b93da8976c150A',
  ezETH:  '0x2416092f143378750bb29b79eD961ab195CcEea5',
  GHO:    '0x6Bb7a212910682DCFdbd5BCBb3e28FB4E8da10Ee',
  EURC:   '0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42',
  AERO:   '0x940181a94A35A4569E4529A3CDfB74e38FD98631',
  tBTC:   '0x236aa50979D5f3De3Bd1Eeb40E81137F22ab794b',
  DEGEN:  '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed',
  BRETT:  '0x532f27101965dd16442E59d40670FaF5eBB142E4',
  USDp:   '0xB79DD08EA68A908A97220C76d19A6aA9cBDE4376',
} as const;

/**
 * Curated seed pools — ALL addresses verified on-chain via Multicall3 → factory.getPool()
 * with token0/token1 ordering confirmed via pool.token0()/pool.token1().
 *
 * 86 pools across 6 DEXes covering all major Aave V3 flash-loanable assets on Base.
 *
 * Last verified: Base mainnet, Feb 2025
 */
const VERIFIED_SEED_POOLS: RawPoolData[] = [

  // ══════════════════════════════════════════════════════════════════════════════
  // UNISWAP V3 — verified via factory.getPool() + token0/token1 confirmed
  // ══════════════════════════════════════════════════════════════════════════════

  // WETH/USDC (3 fee tiers)
  { address: '0xd0b53D9277642d899DF5C87A3966A349A798F224', token0: T.WETH, token1: T.USDC, dexName: 'Uniswap V3', version: ProtocolVersion.V3, fee: 500 },
  { address: '0x6c561B446416E1A00E8E93E221854d6eA4171372', token0: T.WETH, token1: T.USDC, dexName: 'Uniswap V3', version: ProtocolVersion.V3, fee: 3000 },
  { address: '0x0b1C2DCbBfA744ebD3fC17fF1A96A1E1Eb4B2d69', token0: T.WETH, token1: T.USDC, dexName: 'Uniswap V3', version: ProtocolVersion.V3, fee: 10000 },
  // WETH/USDbC
  { address: '0x4C36388bE6F416A29C8d8Eee81C771cE6bE14B18', token0: T.WETH, token1: T.USDbC, dexName: 'Uniswap V3', version: ProtocolVersion.V3, fee: 500 },
  { address: '0x3DdF264AC95D19e81f8c25f4c300C4e59e424d43', token0: T.WETH, token1: T.USDbC, dexName: 'Uniswap V3', version: ProtocolVersion.V3, fee: 3000 },
  // WETH/USDT
  { address: '0xd92E0767473D1E3FF11Ac036f2b1DB90aD0aE55F', token0: T.WETH, token1: T.USDT, dexName: 'Uniswap V3', version: ProtocolVersion.V3, fee: 500 },
  { address: '0xcE1d8c90A5F0ef28fe0F457e5Ad615215899319a', token0: T.WETH, token1: T.USDT, dexName: 'Uniswap V3', version: ProtocolVersion.V3, fee: 3000 },
  // cbETH/WETH
  { address: '0x10648BA41B8565907Cfa1496765fA4D95390aa0d', token0: T.cbETH, token1: T.WETH, dexName: 'Uniswap V3', version: ProtocolVersion.V3, fee: 500 },
  { address: '0x7B9636266734270DE5bE02544c04E27046903ff8', token0: T.cbETH, token1: T.WETH, dexName: 'Uniswap V3', version: ProtocolVersion.V3, fee: 3000 },
  // wstETH/WETH (token0=WETH, token1=wstETH)
  { address: '0x20E068D76f9E90b90604500B84c7e19dCB923e7e', token0: T.WETH, token1: T.wstETH, dexName: 'Uniswap V3', version: ProtocolVersion.V3, fee: 100 },
  { address: '0x6f4482cBF7b43599078fcb012732e20480015644', token0: T.WETH, token1: T.wstETH, dexName: 'Uniswap V3', version: ProtocolVersion.V3, fee: 500 },
  // weETH/WETH
  { address: '0x33dfD66802CC936a58a0B25B5E4F792c1CA2312E', token0: T.weETH, token1: T.WETH, dexName: 'Uniswap V3', version: ProtocolVersion.V3, fee: 500 },
  { address: '0x06b80B12048a37f3762a0015A80Ac0BB37C4e539', token0: T.weETH, token1: T.WETH, dexName: 'Uniswap V3', version: ProtocolVersion.V3, fee: 3000 },
  // ezETH/WETH
  { address: '0x58603091b4Da10685e114d85E330Cab36e655627', token0: T.ezETH, token1: T.WETH, dexName: 'Uniswap V3', version: ProtocolVersion.V3, fee: 500 },
  { address: '0x78aDEE7Cc019eECFc31F6b961d51177A5830E738', token0: T.ezETH, token1: T.WETH, dexName: 'Uniswap V3', version: ProtocolVersion.V3, fee: 3000 },
  // rETH/WETH
  { address: '0x4e840AADD28DA189B9906674B4Afcb77C128d9ea', token0: T.WETH, token1: T.rETH, dexName: 'Uniswap V3', version: ProtocolVersion.V3, fee: 500 },
  // cbBTC/WETH
  { address: '0x7AeA2E8A3843516afa07293a10Ac8E49906dabD1', token0: T.WETH, token1: T.cbBTC, dexName: 'Uniswap V3', version: ProtocolVersion.V3, fee: 500 },
  { address: '0x8c7080564B5A792A33Ef2FD473fbA6364d5495e5', token0: T.WETH, token1: T.cbBTC, dexName: 'Uniswap V3', version: ProtocolVersion.V3, fee: 3000 },
  // cbBTC/USDC
  { address: '0xfBB6Eed8e7aa03B138556eeDaF5D271A5E1e43ef', token0: T.USDC, token1: T.cbBTC, dexName: 'Uniswap V3', version: ProtocolVersion.V3, fee: 500 },
  { address: '0xeC558e484cC9f2210714E345298fdc53B253c27D', token0: T.USDC, token1: T.cbBTC, dexName: 'Uniswap V3', version: ProtocolVersion.V3, fee: 3000 },
  // tBTC/WETH
  { address: '0x9fee7385a2979D15277C3467Db7D99EF1A2669D7', token0: T.tBTC, token1: T.WETH, dexName: 'Uniswap V3', version: ProtocolVersion.V3, fee: 3000 },
  // USDC/USDbC
  { address: '0x06959273E9A65433De71F5A452D529544E07dDD0', token0: T.USDC, token1: T.USDbC, dexName: 'Uniswap V3', version: ProtocolVersion.V3, fee: 100 },
  { address: '0x92722287D2819012dD8EC07b4e426AC00Dd11103', token0: T.USDC, token1: T.USDbC, dexName: 'Uniswap V3', version: ProtocolVersion.V3, fee: 500 },
  // DAI/USDC
  { address: '0x6d0b9C9E92a3De30081563c3657B5258b3fFa38B', token0: T.DAI, token1: T.USDC, dexName: 'Uniswap V3', version: ProtocolVersion.V3, fee: 100 },
  // WETH/DAI
  { address: '0x6446021F4E396dA3df4235C62537431372195D38', token0: T.DAI, token1: T.WETH, dexName: 'Uniswap V3', version: ProtocolVersion.V3, fee: 3000 },
  // GHO/USDC
  { address: '0x3932B99ee1Be1777ED661e08288108A423043a75', token0: T.GHO, token1: T.USDC, dexName: 'Uniswap V3', version: ProtocolVersion.V3, fee: 500 },
  { address: '0xbaF56aeD39b4583c526971Ab51f8F2D4d8e59eb7', token0: T.GHO, token1: T.USDC, dexName: 'Uniswap V3', version: ProtocolVersion.V3, fee: 3000 },
  // EURC/USDC
  { address: '0x7279c08A36333e12c3Fc81747963264c100D66fB', token0: T.EURC, token1: T.USDC, dexName: 'Uniswap V3', version: ProtocolVersion.V3, fee: 500 },
  // AERO/WETH (token0=WETH, token1=AERO)
  { address: '0x3d5D143381916280ff91407FeBEB52f2b60f33Cf', token0: T.WETH, token1: T.AERO, dexName: 'Uniswap V3', version: ProtocolVersion.V3, fee: 3000 },
  { address: '0x0D5959a52E7004b601f0bE70618D01aC3cDce976', token0: T.WETH, token1: T.AERO, dexName: 'Uniswap V3', version: ProtocolVersion.V3, fee: 10000 },
  // DEGEN/WETH (token0=WETH, token1=DEGEN)
  { address: '0xc9034c3E7F58003E6ae0C8438e7c8f4598d5ACAA', token0: T.WETH, token1: T.DEGEN, dexName: 'Uniswap V3', version: ProtocolVersion.V3, fee: 3000 },
  { address: '0x0cA6485b7e9cF814A3Fd09d81672B07323535b64', token0: T.WETH, token1: T.DEGEN, dexName: 'Uniswap V3', version: ProtocolVersion.V3, fee: 10000 },
  // DEGEN/USDC
  { address: '0x29715d8D279cAB143A12fF515b40a2b35d7BAD37', token0: T.DEGEN, token1: T.USDC, dexName: 'Uniswap V3', version: ProtocolVersion.V3, fee: 10000 },
  // BRETT/WETH (token0=WETH, token1=BRETT)
  { address: '0x76Bf0abD20f1e0155Ce40A62615a90A709a6C3D8', token0: T.WETH, token1: T.BRETT, dexName: 'Uniswap V3', version: ProtocolVersion.V3, fee: 3000 },
  { address: '0xBA3F945812a83471d709BCe9C3CA699A19FB46f7', token0: T.WETH, token1: T.BRETT, dexName: 'Uniswap V3', version: ProtocolVersion.V3, fee: 10000 },
  // BRETT/USDC
  { address: '0xBF0A0C12E7C0610002F6Aa6E609755EDe42D6A4d', token0: T.BRETT, token1: T.USDC, dexName: 'Uniswap V3', version: ProtocolVersion.V3, fee: 10000 },

  // ══════════════════════════════════════════════════════════════════════════════
  // AERODROME V2 (Classic AMM) — verified via factory.getPool(t0,t1,stable)
  // ══════════════════════════════════════════════════════════════════════════════

  // WETH/USDC — volatile (fee=30) and stable (fee=5)
  { address: '0xcDAC0d6c6C59727a65F871236188350531885C43', token0: T.WETH, token1: T.USDC, dexName: 'Aerodrome', version: ProtocolVersion.V2, fee: 30, stable: false },
  { address: '0x3548029694fbB241D45FB24Ba0cd9c9d4E745f16', token0: T.WETH, token1: T.USDC, dexName: 'Aerodrome', version: ProtocolVersion.V2, fee: 5, stable: true },
  // WETH/USDT volatile
  { address: '0xFFD4Ec4BD2211cBFD58C209FdEcC65F63f2b9e4c', token0: T.WETH, token1: T.USDT, dexName: 'Aerodrome', version: ProtocolVersion.V2, fee: 30, stable: false },
  // USDC/USDbC stable
  { address: '0x27a8Afa3Bd49406e48a074350fB7b2020c43B2bD', token0: T.USDC, token1: T.USDbC, dexName: 'Aerodrome', version: ProtocolVersion.V2, fee: 5, stable: true },
  // USDC/USDT stable
  { address: '0x96508AE8037c6bD16162620187691F1c1e3e07C1', token0: T.USDC, token1: T.USDT, dexName: 'Aerodrome', version: ProtocolVersion.V2, fee: 5, stable: true },
  // cbETH/WETH — volatile (fee=30) and stable (fee=5)
  { address: '0x44Ecc644449fC3a9858d2007CaA8CFAa4C561f91', token0: T.cbETH, token1: T.WETH, dexName: 'Aerodrome', version: ProtocolVersion.V2, fee: 30, stable: false },
  { address: '0x9E8bfEB5c73F3f897BebdB49CC4161FecE0B0c55', token0: T.cbETH, token1: T.WETH, dexName: 'Aerodrome', version: ProtocolVersion.V2, fee: 5, stable: true },
  // wstETH/WETH — stable (fee=5) and volatile (fee=30)
  { address: '0x29BBb5F85F01702Ec85D217CEEb2d9657700cF04', token0: T.WETH, token1: T.wstETH, dexName: 'Aerodrome', version: ProtocolVersion.V2, fee: 5, stable: true },
  { address: '0xA6385c73961dd9C58db2EF0c4EB98cE4B60651e8', token0: T.WETH, token1: T.wstETH, dexName: 'Aerodrome', version: ProtocolVersion.V2, fee: 30, stable: false },
  // rETH/WETH — stable (fee=5) and volatile (fee=30)
  { address: '0xb8866732424AcDdd729C6fcf7146b19bFE4A2e36', token0: T.WETH, token1: T.rETH, dexName: 'Aerodrome', version: ProtocolVersion.V2, fee: 5, stable: true },
  { address: '0xA6F8A6bc3deA678d5bA786f2Ad2f5F93d1c87c18', token0: T.WETH, token1: T.rETH, dexName: 'Aerodrome', version: ProtocolVersion.V2, fee: 30, stable: false },
  // DAI/USDC stable
  { address: '0x67b00B46FA4f4F24c03855c5C8013C0B938B3eEc', token0: T.DAI, token1: T.USDC, dexName: 'Aerodrome', version: ProtocolVersion.V2, fee: 5, stable: true },
  // WETH/cbBTC volatile
  { address: '0x2578365B3dfA7FfE60108e181EFb79FeDdec2319', token0: T.WETH, token1: T.cbBTC, dexName: 'Aerodrome', version: ProtocolVersion.V2, fee: 30, stable: false },
  // weETH/WETH volatile
  { address: '0x91F0f34916Ca4E2cCe120116774b0e4fA0cdcaA8', token0: T.weETH, token1: T.WETH, dexName: 'Aerodrome', version: ProtocolVersion.V2, fee: 30, stable: false },
  // ezETH/WETH volatile
  { address: '0x0C8bF3cb3E1f951B284EF14aa95444be86a33E2f', token0: T.ezETH, token1: T.WETH, dexName: 'Aerodrome', version: ProtocolVersion.V2, fee: 30, stable: false },
  // AERO/WETH volatile (token0=WETH, token1=AERO)
  { address: '0x7f670f78B17dEC44d5Ef68a48740b6f8849cc2e6', token0: T.WETH, token1: T.AERO, dexName: 'Aerodrome', version: ProtocolVersion.V2, fee: 30, stable: false },
  // AERO/USDC volatile (token0=USDC, token1=AERO)
  { address: '0x6cDcb1C4A4D1C3C6d054b27AC5B77e89eAFb971d', token0: T.USDC, token1: T.AERO, dexName: 'Aerodrome', version: ProtocolVersion.V2, fee: 30, stable: false },
  // DEGEN/WETH volatile (token0=WETH, token1=DEGEN)
  { address: '0x2C4909355b0C036840819484c3A882A95659aBf3', token0: T.WETH, token1: T.DEGEN, dexName: 'Aerodrome', version: ProtocolVersion.V2, fee: 30, stable: false },
  // BRETT/WETH volatile (token0=WETH, token1=BRETT)
  { address: '0x214356Cc4aAb907244A791CA9735292860490D5A', token0: T.WETH, token1: T.BRETT, dexName: 'Aerodrome', version: ProtocolVersion.V2, fee: 30, stable: false },
  // cbBTC/USDC volatile (token0=USDC, token1=cbBTC)
  { address: '0x9c38b55f9A9Aba91BbCEDEb12bf4428f47A6a0B8', token0: T.USDC, token1: T.cbBTC, dexName: 'Aerodrome', version: ProtocolVersion.V2, fee: 30, stable: false },
  // EURC/USDC stable
  { address: '0xeF0d374FE41fC6dA7f8ED7c56C10A8f2A4f75313', token0: T.EURC, token1: T.USDC, dexName: 'Aerodrome', version: ProtocolVersion.V2, fee: 5, stable: true },

  // ══════════════════════════════════════════════════════════════════════════════
  // AERODROME SLIPSTREAM (Concentrated Liquidity) — verified via factory.getPool(t0,t1,ts)
  // ══════════════════════════════════════════════════════════════════════════════

  // WETH/USDC CL (ts=100, dynamic fee ~436 ppm)
  { address: '0xb2cc224c1c9feE385f8ad6a55b4d94E92359DC59', token0: T.WETH, token1: T.USDC, dexName: 'Aerodrome Slipstream', version: ProtocolVersion.V3, fee: 436, tickSpacing: 100 },
  // WETH/USD+ CL (ts=100, dynamic fee ~400 ppm)
  { address: '0x4D69971CCd4A636c403a3C1B00c85e99bB9B5606', token0: T.WETH, token1: T.USDp, dexName: 'Aerodrome Slipstream', version: ProtocolVersion.V3, fee: 400, tickSpacing: 100 },
  // USDC/USDbC CL (ts=1, fee=100 ppm)
  { address: '0x98c7A2338336d2d354663246F64676009c7bDa97', token0: T.USDC, token1: T.USDbC, dexName: 'Aerodrome Slipstream', version: ProtocolVersion.V3, fee: 100, tickSpacing: 1 },
  // cbETH/WETH CL (ts=1, fee=90 ppm)
  { address: '0x47cA96Ea59C13F72745928887f84C9F52C3D7348', token0: T.cbETH, token1: T.WETH, dexName: 'Aerodrome Slipstream', version: ProtocolVersion.V3, fee: 90, tickSpacing: 1 },
  // wstETH/WETH CL (ts=1, fee=90 ppm)
  { address: '0x861A2922bE165a5Bd41b1E482B49216b465e1B5F', token0: T.WETH, token1: T.wstETH, dexName: 'Aerodrome Slipstream', version: ProtocolVersion.V3, fee: 90, tickSpacing: 1 },
  // wstETH/WETH CL (ts=100, fee=500 ppm)
  { address: '0xC5e47133b68c6c50298312829cB4d4f56eD43325', token0: T.WETH, token1: T.wstETH, dexName: 'Aerodrome Slipstream', version: ProtocolVersion.V3, fee: 500, tickSpacing: 100 },
  // cbBTC/WETH CL (ts=100, fee=420 ppm)
  { address: '0x70aCDF2Ad0bf2402C957154f944c19Ef4e1cbAE1', token0: T.WETH, token1: T.cbBTC, dexName: 'Aerodrome Slipstream', version: ProtocolVersion.V3, fee: 420, tickSpacing: 100 },
  // cbBTC/USDC CL (ts=100, fee=390 ppm)
  { address: '0x4e962BB3889Bf030368F56810A9c96B83CB3E778', token0: T.USDC, token1: T.cbBTC, dexName: 'Aerodrome Slipstream', version: ProtocolVersion.V3, fee: 390, tickSpacing: 100 },
  // AERO/WETH CL (ts=200, fee=3000 ppm)
  { address: '0x82321f3BEB69f503380D6B233857d5C43562e2D0', token0: T.WETH, token1: T.AERO, dexName: 'Aerodrome Slipstream', version: ProtocolVersion.V3, fee: 3000, tickSpacing: 200 },
  // AERO/USDC CL (ts=200, fee=3000 ppm)
  { address: '0xCCd9cC53b63662088c738B8BC06E9078Fb8D9ad4', token0: T.USDC, token1: T.AERO, dexName: 'Aerodrome Slipstream', version: ProtocolVersion.V3, fee: 3000, tickSpacing: 200 },
  // weETH/WETH CL (ts=1, fee=85 ppm)
  { address: '0xbD3cd0D9d429b41F0a2e1C026552Bd598294d5E0', token0: T.weETH, token1: T.WETH, dexName: 'Aerodrome Slipstream', version: ProtocolVersion.V3, fee: 85, tickSpacing: 1 },
  // ezETH/WETH CL (ts=1, fee=400 ppm)
  { address: '0xDC7EAd706795eDa3FEDa08Ad519d9452BAdF2C0d', token0: T.ezETH, token1: T.WETH, dexName: 'Aerodrome Slipstream', version: ProtocolVersion.V3, fee: 400, tickSpacing: 1 },
  // EURC/USDC CL (ts=1, fee=70 ppm)
  { address: '0xc5E51044eB7318950B1aFb044FccFb25782C48c1', token0: T.EURC, token1: T.USDC, dexName: 'Aerodrome Slipstream', version: ProtocolVersion.V3, fee: 70, tickSpacing: 1 },
  // USDC/USDT CL (ts=1, fee=9 ppm)
  { address: '0xa41Bc0AFfbA7Fd420d186b84899d7ab2aC57fcD1', token0: T.USDC, token1: T.USDT, dexName: 'Aerodrome Slipstream', version: ProtocolVersion.V3, fee: 9, tickSpacing: 1 },
  // DEGEN/WETH CL (ts=200, fee=2451 ppm)
  { address: '0xaFB62448929664Bfccb0aAe22f232520e765bA88', token0: T.WETH, token1: T.DEGEN, dexName: 'Aerodrome Slipstream', version: ProtocolVersion.V3, fee: 2451, tickSpacing: 200 },
  // BRETT/WETH CL (ts=200, fee=2111 ppm)
  { address: '0x4e829F8A5213c42535AB84AA40BD4aDCCE9cBa02', token0: T.WETH, token1: T.BRETT, dexName: 'Aerodrome Slipstream', version: ProtocolVersion.V3, fee: 2111, tickSpacing: 200 },

  // ══════════════════════════════════════════════════════════════════════════════
  // PANCAKESWAP V3 — verified via factory.getPool()
  // ══════════════════════════════════════════════════════════════════════════════

  // WETH/USDC
  { address: '0xB775272E537cc670C65DC852908aD47015244EaF', token0: T.WETH, token1: T.USDC, dexName: 'PancakeSwap V3', version: ProtocolVersion.V3, fee: 500 },
  { address: '0xE9d76696f8A35e2E2520e3125875C3af23f1E69c', token0: T.WETH, token1: T.USDC, dexName: 'PancakeSwap V3', version: ProtocolVersion.V3, fee: 2500 },
  // WETH/USDbC
  { address: '0xe58b73fF901325b8b2056B29712C50237242F520', token0: T.WETH, token1: T.USDbC, dexName: 'PancakeSwap V3', version: ProtocolVersion.V3, fee: 500 },
  // cbETH/WETH
  { address: '0xc0efC182479319ff258EcA420e2647cD82D3790c', token0: T.cbETH, token1: T.WETH, dexName: 'PancakeSwap V3', version: ProtocolVersion.V3, fee: 500 },
  // cbBTC/WETH (token0=WETH, token1=cbBTC)
  { address: '0xd974D59e30054cf1aBedeD0C9947B0D8Baf90029', token0: T.WETH, token1: T.cbBTC, dexName: 'PancakeSwap V3', version: ProtocolVersion.V3, fee: 500 },
  // cbBTC/USDC (token0=USDC, token1=cbBTC)
  { address: '0x26e263efdc91f0d3279E2Ec2Bd58A7Ca5C2fCE62', token0: T.USDC, token1: T.cbBTC, dexName: 'PancakeSwap V3', version: ProtocolVersion.V3, fee: 500 },
  // wstETH/WETH (token0=WETH, token1=wstETH)
  { address: '0xBd59a718E60bd868123C6E949c9fd97185EFbDB7', token0: T.WETH, token1: T.wstETH, dexName: 'PancakeSwap V3', version: ProtocolVersion.V3, fee: 100 },
  // USDC/USDbC
  { address: '0x29Ed55B18Af0Add137952CB3E29FB77B32fCE426', token0: T.USDC, token1: T.USDbC, dexName: 'PancakeSwap V3', version: ProtocolVersion.V3, fee: 100 },

  // ══════════════════════════════════════════════════════════════════════════════
  // SUSHISWAP V3 — verified via factory.getPool()
  // ══════════════════════════════════════════════════════════════════════════════

  // WETH/USDC
  { address: '0x57713F7716e0b0F65ec116912F834E49805480d2', token0: T.WETH, token1: T.USDC, dexName: 'SushiSwap V3', version: ProtocolVersion.V3, fee: 500 },
  { address: '0x41595326AaBe6132FC6C7aE71Af087A3A9DBC9F6', token0: T.WETH, token1: T.USDC, dexName: 'SushiSwap V3', version: ProtocolVersion.V3, fee: 3000 },
  // WETH/USDbC
  { address: '0x22ca6d83aB887A535ae1C6011cc36eA9D1255C31', token0: T.WETH, token1: T.USDbC, dexName: 'SushiSwap V3', version: ProtocolVersion.V3, fee: 500 },
  // cbETH/WETH
  { address: '0xb81B9Aef36c76d740850C31C45697c83468DCB54', token0: T.cbETH, token1: T.WETH, dexName: 'SushiSwap V3', version: ProtocolVersion.V3, fee: 500 },

  // ══════════════════════════════════════════════════════════════════════════════
  // BASESWAP V2 — verified via factory.getPair()
  // ══════════════════════════════════════════════════════════════════════════════

  // WETH/USDC
  { address: '0xab067c01C7F5734da168C699Ae9d23a4512c9FdB', token0: T.WETH, token1: T.USDC, dexName: 'BaseSwap V2', version: ProtocolVersion.V2, fee: 30 },
  // WETH/USDbC
  { address: '0x41d160033C222E6f3722EC97379867324567d883', token0: T.WETH, token1: T.USDbC, dexName: 'BaseSwap V2', version: ProtocolVersion.V2, fee: 30 },

  // ══════════════════════════════════════════════════════════════════════════════
  // SUSHISWAP V2 — verified
  // ══════════════════════════════════════════════════════════════════════════════

  // WETH/USDC
  { address: '0x2F8818D1B0f3e3E295440c1C0cDDf40aAA21fA87', token0: T.WETH, token1: T.USDC, dexName: 'SushiSwap V2', version: ProtocolVersion.V2, fee: 30 },
];

export class DiscoveryEngine extends EventEmitter {
  private config: Config;
  private provider: ethers.Provider;
  private aaveFetcher: AaveAssetFetcher;
  private poolIndexer: PoolIndexer;
  private registryWriter: PoolRegistryWriter;
  private incrementalUpdater: IncrementalUpdater;
  private cronJob: cron.ScheduledTask | null;
  private registry: PoolRegistry | null;
  private running: boolean;
  private initialized: boolean;

  constructor(config: Config, provider: ethers.Provider) {
    super();
    this.config = config;
    this.provider = provider;
    this.cronJob = null;
    this.registry = null;
    this.running = false;
    this.initialized = false;

    const multicall = new MulticallBatcher(provider, config.discoveryBatchSize);
    this.aaveFetcher = new AaveAssetFetcher(provider);
    this.poolIndexer = new PoolIndexer(provider, multicall, config.discoveryBatchSize, config.discoveryBlockRange);
    this.registryWriter = new PoolRegistryWriter(provider);
    this.incrementalUpdater = new IncrementalUpdater(provider, config.discoveryBlockRange);
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    logger.info('Initializing discovery engine');

    this.registry = this.registryWriter.readRegistry();
    const aaveAssets = await this.aaveFetcher.fetchFlashLoanableAssets();

    if (this.registry.meta.lastIndexedBlock === 0) {
      logger.info('No existing registry found, running full discovery');
      await this._runFullDiscovery(aaveAssets);
    } else {
      logger.info('Existing registry found, running incremental update', {
        lastIndexedBlock: this.registry.meta.lastIndexedBlock,
        totalPools: this.registry.meta.totalPools,
      });
      await this._runIncrementalUpdate(aaveAssets);
    }

    this._scheduleCronJob();

    this.initialized = true;
    logger.info('Discovery engine initialized', {
      totalPools: this.registry?.meta.totalPools ?? 0,
    });
  }

  getRegistry(): PoolRegistry {
    if (!this.registry) {
      this.registry = this.registryWriter.readRegistry();
    }
    return this.registry;
  }

  async forceFullDiscovery(): Promise<DiscoveryResult> {
    const aaveAssets = await this.aaveFetcher.fetchFlashLoanableAssets(true);
    return this._runFullDiscovery(aaveAssets);
  }

  async forceIncrementalUpdate(): Promise<void> {
    const aaveAssets = await this.aaveFetcher.fetchFlashLoanableAssets();
    await this._runIncrementalUpdate(aaveAssets);
  }

  stop(): void {
    if (this.cronJob) {
      this.cronJob.stop();
      this.cronJob = null;
    }
    this.running = false;
    this.removeAllListeners();
    logger.info('Discovery engine stopped');
  }

  private async _runFullDiscovery(aaveAssets: Set<string>): Promise<DiscoveryResult> {
    const startTime = Date.now();
    this.running = true;

    logger.info('Starting full pool discovery');

    try {
      let rawPools: Map<string, RawPoolData>;
      const canUseLogs = await this._probeEthGetLogs();

      if (!canUseLogs) {
        logger.warn(
          'eth_getLogs unavailable (free-tier RPC). Falling back to curated seed pool list. ' +
          'Upgrade to Alchemy PAYG or QuickNode paid plan for full discovery.',
        );
        rawPools = this._buildSeedPoolMap();
      } else {
        try {
          rawPools = await this.poolIndexer.indexAllPools(aaveAssets);
          logger.info('Pool indexing complete', { poolsFound: rawPools.size });
          // Always merge seed pools to ensure coverage
          for (const pool of VERIFIED_SEED_POOLS) {
            if (!rawPools.has(pool.address.toLowerCase())) {
              rawPools.set(pool.address.toLowerCase(), pool);
            }
          }
        } catch (indexError) {
          logger.warn('Pool indexer failed, falling back to seed pools', {
            error: (indexError as Error).message.slice(0, 120),
          });
          rawPools = this._buildSeedPoolMap();
        }
      }

      const currentBlock = await this.provider.getBlockNumber();

      const existingRegistry = this.registryWriter.readRegistry();
      const { registry, newCount } = await this.registryWriter.mergeNewPools(
        existingRegistry,
        rawPools,
        aaveAssets,
        currentBlock
      );

      const removed = this.registryWriter.removeZeroLiquidityPools(registry);

      this.registryWriter.writeRegistry(registry);
      this.registry = registry;

      const dexBreakdown: Record<string, number> = {};
      for (const pool of Object.values(registry.pools)) {
        dexBreakdown[pool.dex] = (dexBreakdown[pool.dex] || 0) + 1;
      }

      const result: DiscoveryResult = {
        totalPoolsScanned: rawPools.size,
        poolsRetained: Object.keys(registry.pools).length,
        newPoolsAdded: newCount,
        poolsRemovedZeroLiquidity: removed,
        dexBreakdown,
        duration: Date.now() - startTime,
      };

      logger.info('Full discovery complete', result);
      this.emit('poolsUpdated', registry, result);

      return result;
    } catch (error) {
      logger.error('Full discovery failed', { error: (error as Error).message });
      throw error;
    } finally {
      this.running = false;
    }
  }

  private async _runIncrementalUpdate(aaveAssets: Set<string>): Promise<void> {
    if (this.running) {
      logger.warn('Discovery already running, skipping incremental update');
      return;
    }

    this.running = true;

    try {
      const lastBlock = this.registry?.meta.lastIndexedBlock ?? 0;
      const { pools, result } = await this.incrementalUpdater.fetchNewPools(lastBlock, aaveAssets);

      if (pools.size > 0) {
        const currentBlock = await this.provider.getBlockNumber();
        const existingRegistry = this.registry ?? this.registryWriter.readRegistry();
        const { registry, newCount } = await this.registryWriter.mergeNewPools(
          existingRegistry,
          pools,
          aaveAssets,
          currentBlock
        );

        this.registryWriter.writeRegistry(registry);
        this.registry = registry;

        logger.info('Incremental update merged', { newPools: newCount });
        this.emit('poolsUpdated', registry, result);
      } else {
        if (this.registry) {
          this.registry.meta.lastIndexedBlock = result.toBlock;
          this.registry.meta.lastUpdatedTimestamp = new Date().toISOString();
          this.registryWriter.writeRegistry(this.registry);
        }
      }
    } catch (error) {
      logger.error('Incremental update failed', { error: (error as Error).message });
    } finally {
      this.running = false;
    }
  }

  /**
   * Probes whether eth_getLogs is usable on the current RPC.
   * Returns false if the RPC rejects a 100-block range request (free-tier).
   */
  private async _probeEthGetLogs(): Promise<boolean> {
    try {
      const currentBlock = await this.provider.getBlockNumber();
      await this.provider.getLogs({
        fromBlock: currentBlock - 100,
        toBlock: currentBlock,
        topics: [],
      });
      return true;
    } catch (error) {
      const msg = (error as Error).message || '';
      if (
        msg.includes('block range') ||
        msg.includes('Free tier') ||
        msg.includes('eth_getLogs') ||
        msg.includes('-32600') ||
        msg.includes('-32011') ||
        msg.includes('no backend')
      ) {
        return false;
      }
      logger.debug('eth_getLogs probe returned unexpected error, assuming available', {
        error: msg.slice(0, 80),
      });
      return true;
    }
  }

  /**
   * Builds a pool map from the curated VERIFIED_SEED_POOLS list.
   * Deduplicates by address (lowercase).
   */
  private _buildSeedPoolMap(): Map<string, RawPoolData> {
    const map = new Map<string, RawPoolData>();
    for (const pool of VERIFIED_SEED_POOLS) {
      const key = pool.address.toLowerCase();
      if (!map.has(key)) {
        map.set(key, pool);
      }
    }
    logger.info('Seed pools loaded', { count: map.size });
    return map;
  }

  private _scheduleCronJob(): void {
    if (this.cronJob) {
      this.cronJob.stop();
    }

    this.cronJob = cron.schedule(this.config.discoveryCron, async () => {
      logger.info('Cron-triggered incremental update');
      try {
        const aaveAssets = await this.aaveFetcher.fetchFlashLoanableAssets();
        await this._runIncrementalUpdate(aaveAssets);
      } catch (error) {
        logger.error('Cron incremental update failed', { error: (error as Error).message });
      }
    });

    logger.info('Discovery cron scheduled', { schedule: this.config.discoveryCron });
  }
}