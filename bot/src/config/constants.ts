/**
 * @file constants.ts
 * @description Non-address constants: DEX ID enum, protocol version enum, fee tier lists,
 *              BigInt constants, log level config, retry parameters.
 */

// ─── DEX Identifiers ────────────────────────────────────────────────────
// Numeric IDs mapping to DEX names for contract encoding
export enum DexId {
  UNISWAP_V2 = 0,
  UNISWAP_V3 = 1,
  SUSHISWAP_V2 = 2,
  SUSHISWAP_V3 = 3,
  AERODROME = 4,
  AERODROME_SLIPSTREAM = 5,
  BASESWAP_V2 = 6,
  BASESWAP_V3 = 7,
  SWAPBASED = 8,
  PANCAKESWAP_V3 = 9,
  ZERO_X = 10,
}

export const DEX_NAMES: Record<number, string> = {
  [DexId.UNISWAP_V2]: 'Uniswap V2',
  [DexId.UNISWAP_V3]: 'Uniswap V3',
  [DexId.SUSHISWAP_V2]: 'SushiSwap V2',
  [DexId.SUSHISWAP_V3]: 'SushiSwap V3',
  [DexId.AERODROME]: 'Aerodrome',
  [DexId.AERODROME_SLIPSTREAM]: 'Aerodrome Slipstream',
  [DexId.BASESWAP_V2]: 'BaseSwap V2',
  [DexId.BASESWAP_V3]: 'BaseSwap V3',
  [DexId.SWAPBASED]: 'SwapBased',
  [DexId.PANCAKESWAP_V3]: 'PancakeSwap V3',
  [DexId.ZERO_X]: '0x Aggregator',
};

// ─── Protocol Versions ──────────────────────────────────────────────────
export enum ProtocolVersion {
  V2 = 'V2',
  V3 = 'V3',
}

// Map DEX IDs to their protocol version
export const DEX_PROTOCOL_VERSION: Record<number, ProtocolVersion> = {
  [DexId.UNISWAP_V2]: ProtocolVersion.V2,
  [DexId.UNISWAP_V3]: ProtocolVersion.V3,
  [DexId.SUSHISWAP_V2]: ProtocolVersion.V2,
  [DexId.SUSHISWAP_V3]: ProtocolVersion.V3,
  [DexId.AERODROME]: ProtocolVersion.V2,
  [DexId.AERODROME_SLIPSTREAM]: ProtocolVersion.V3,
  [DexId.BASESWAP_V2]: ProtocolVersion.V2,
  [DexId.BASESWAP_V3]: ProtocolVersion.V3,
  [DexId.SWAPBASED]: ProtocolVersion.V2,
  [DexId.PANCAKESWAP_V3]: ProtocolVersion.V3,
};

// ─── V3 Fee Tiers ───────────────────────────────────────────────────────
// Fee tiers in hundredths of a bip (e.g., 500 = 0.05%)
export const V3_FEE_TIERS = {
  uniswapV3: [100, 500, 3000, 10000] as const,
  sushiswapV3: [100, 500, 3000, 10000] as const,
  baseswapV3: [100, 500, 2500, 10000] as const,
  pancakeswapV3: [100, 500, 2500, 10000] as const,
};

// Aerodrome Slipstream tick spacings
export const AERODROME_TICK_SPACINGS = [1, 2, 5, 10, 50, 100, 200] as const;

// ─── V2 Fee Constants ───────────────────────────────────────────────────
// Fee in basis points (e.g., 30 = 0.3%)
export const V2_FEES: Record<number, number> = {
  [DexId.UNISWAP_V2]: 30,
  [DexId.SUSHISWAP_V2]: 30,
  [DexId.AERODROME]: 30, // Variable, but default
  [DexId.BASESWAP_V2]: 30,
  [DexId.SWAPBASED]: 30,
};

// ─── BigInt Constants ───────────────────────────────────────────────────
export const BIGINT_ZERO = 0n;
export const BIGINT_ONE = 1n;
export const BIGINT_TWO = 2n;
export const BIGINT_TEN = 10n;
export const BIGINT_96 = 96n;
export const BIGINT_128 = 128n;
export const BIGINT_192 = 192n;
export const BIGINT_256 = 256n;

// Q96 = 2^96 (used in V3 sqrtPriceX96 math)
export const Q96 = 2n ** 96n;
export const Q128 = 2n ** 128n;
export const Q192 = 2n ** 192n;

// Basis points
export const BPS_BASE = 10000n;
export const PRECISION_18 = 10n ** 18n;
export const PRECISION_6 = 10n ** 6n;
export const PRECISION_8 = 10n ** 8n;

// Max uint256
export const MAX_UINT256 = 2n ** 256n - 1n;

// V3 tick bounds
export const MIN_TICK = -887272;
export const MAX_TICK = 887272;
export const MIN_SQRT_RATIO = 4295128739n;
export const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;

// ─── Flash Loan Constants ───────────────────────────────────────────────
// Aave V3 flash loan premium in basis points (5 = 0.05%)
export const FLASH_LOAN_PREMIUM_BPS = 5n;
export const FLASH_LOAN_PREMIUM_DIVISOR = 10000n;

// ─── Flash Amount Caps (per token, in token native units) ─────────────────────
// Hard caps to prevent absurd flash amounts from low-liquidity pools.
// These are conservative maximums — real profitable arb rarely needs more.
export const FLASH_AMOUNT_CAPS: Record<string, bigint> = {
  // Stablecoins: max $50,000
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 50_000n * 10n ** 6n,   // USDC
  '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca': 50_000n * 10n ** 6n,   // USDbC
  '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2': 50_000n * 10n ** 6n,   // USDT
  '0x50c5725949a6f0c72e6c4a641f24049a917db0cb': 50_000n * 10n ** 18n,  // DAI
  // ETH-like: max 20 ETH (~$40k)
  '0x4200000000000000000000000000000000000006': 20n * 10n ** 18n,       // WETH
  '0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22': 20n * 10n ** 18n,      // cbETH
  '0xc1cba3fcea344f92d9239c08c0568f6f2f0ee452': 20n * 10n ** 18n,      // wstETH
  '0xb6fe221fe9eeef5aba221c348ba20a1bf5e73624c': 20n * 10n ** 18n,     // rETH
  // BTC-like: max 0.5 BTC (~$34k)
  '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf': 5n * 10n ** 7n,        // cbBTC (8 dec)
  '0x0555e30da8f98308edb960aa94c0db47230d2b9c': 5n * 10n ** 7n,        // WBTC (8 dec)
  '0x236aa50979d5f3de3bd1eeb40e81137f22ab794b': 5n * 10n ** 17n,       // tBTC (18 dec, 0.5 BTC)
  // New Aave assets: ETH-like LSTs
  '0x04c0599ae5a44757c0af6f9ec3b93da8976c150a': 20n * 10n ** 18n,      // weETH
  '0x2416092f143378750bb29b79ed961ab195cceea5': 20n * 10n ** 18n,      // ezETH
  '0xedfa23602d0ec14714057867a78d01e94176bea0': 20n * 10n ** 18n,      // wrsETH
  // Stablecoins
  '0x6bb7a212910682dcfdbd5bcbb3e28fb4e8da10ee': 50_000n * 10n ** 18n,  // GHO (18 dec)
  '0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42': 50_000n * 10n ** 6n,   // EURC (6 dec)
  // High-volume tokens
  '0x940181a94a35a4569e4529a3cdfb74e38fd98631': 50_000n * 10n ** 18n,  // AERO
};

// Default flash amount cap for unknown tokens: 10,000 units (18-decimal)
export const DEFAULT_FLASH_AMOUNT_CAP_18 = 10_000n * 10n ** 18n;

// Minimum pool liquidity (USD) to consider for arbitrage
// Pools below this produce garbage price quotes
export const MIN_POOL_LIQUIDITY_USD = 1_000; // $1,000 minimum TVL

// Minimum V2 reserve (normalized to 18 decimals) to consider a pool valid
export const MIN_V2_RESERVE_NORMALIZED = 100n * 10n ** 18n;

// Maximum price divergence in bps to scan (above this = broken/stale pool)
export const MAX_DIVERGENCE_BPS = 2000; // 20% max

// ─── Gas Constants ──────────────────────────────────────────────────────
// Estimated gas per swap type (calibrated from historical executions)
export const GAS_PER_V2_SWAP = 150_000n;
export const GAS_PER_V3_SWAP = 200_000n;
export const GAS_PER_AERODROME_SWAP = 180_000n;
export const GAS_PER_AERODROME_CL_SWAP = 220_000n;
export const GAS_PER_ZERO_X_SWAP = 300_000n;
export const GAS_FLASH_LOAN_OVERHEAD = 100_000n;
export const GAS_BASE_TX = 21_000n;

// ─── Retry Configuration ────────────────────────────────────────────────
export const RETRY_CONFIG = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 10000,
  jitterFactor: 0.3,
} as const;

// ─── Rate Limiting ──────────────────────────────────────────────────────
export const RATE_LIMIT_CONFIG = {
  zeroXRequestsPerSecond: 5,
  rpcRequestsPerSecond: 50,
} as const;

// ─── Discovery Constants ────────────────────────────────────────────────
export const DISCOVERY_DEFAULTS = {
  batchSize: 200,
  blockRange: 10000,
  maxConcurrentBatches: 5,
} as const;

// ─── Multicall Constants ────────────────────────────────────────────────
export const MULTICALL_BATCH_SIZE = 50; // Conservative default — public RPCs reject large batches
export const MULTICALL_GAS_LIMIT = 30_000_000n;

// ─── Event Signatures ───────────────────────────────────────────────────
export const EVENT_SIGNATURES = {
  // Uniswap V2 / SushiSwap V2 / BaseSwap V2 / SwapBased
  PairCreated: 'PairCreated(address,address,address,uint256)',
  // Uniswap V3 / SushiSwap V3 / BaseSwap V3 / PancakeSwap V3
  PoolCreated_V3: 'PoolCreated(address,address,uint24,int24,address)',
  // Aerodrome classic
  PoolCreated_Aero: 'PoolCreated(address,address,bool,address,uint256)',
  // Aerodrome Slipstream
  PoolCreated_AeroCL: 'PoolCreated(address,address,int24,address)',
} as const;

// ─── ABI Fragments ──────────────────────────────────────────────────────
export const MINIMAL_ERC20_ABI = [
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function balanceOf(address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function transfer(address,uint256) returns (bool)',
  'function allowance(address,address) view returns (uint256)',
] as const;

export const V2_PAIR_ABI = [
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function getReserves() view returns (uint112,uint112,uint32)',
  'function factory() view returns (address)',
] as const;

export const V2_FACTORY_ABI = [
  'function allPairs(uint256) view returns (address)',
  'function allPairsLength() view returns (uint256)',
  'event PairCreated(address indexed token0, address indexed token1, address pair, uint256)',
] as const;

export const V3_POOL_ABI = [
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function fee() view returns (uint24)',
  'function tickSpacing() view returns (int24)',
  'function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)',
  'function liquidity() view returns (uint128)',
] as const;

export const V3_FACTORY_ABI = [
  'function getPool(address,address,uint24) view returns (address)',
  'event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)',
] as const;

export const AERODROME_POOL_ABI = [
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function stable() view returns (bool)',
  'function getReserves() view returns (uint256,uint256,uint256)',
  'function getAmountOut(uint256,address) view returns (uint256)',
  'function metadata() view returns (uint256,uint256,uint256,uint256,bool,address,address)',
] as const;

export const AERODROME_FACTORY_ABI = [
  'function allPools(uint256) view returns (address)',
  'function allPoolsLength() view returns (uint256)',
  'event PoolCreated(address indexed token0, address indexed token1, bool indexed stable, address pool, uint256)',
] as const;

export const AERODROME_CL_POOL_ABI = [
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function tickSpacing() view returns (int24)',
  'function fee() view returns (uint24)',
  'function slot0() view returns (uint160,int24,uint16,uint16,uint16,bool)',
  'function liquidity() view returns (uint128)',
] as const;

export const AERODROME_CL_FACTORY_ABI = [
  'event PoolCreated(address indexed token0, address indexed token1, int24 indexed tickSpacing, address pool)',
] as const;

export const AAVE_V3_POOL_ABI = [
  'function getReservesList() view returns (address[])',
  'function getConfiguration(address asset) view returns (uint256)',
  'function getReserveData(address asset) view returns (uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt)',
  'function flashLoanSimple(address receiverAddress, address asset, uint256 amount, bytes calldata params, uint16 referralCode)',
  'function FLASHLOAN_PREMIUM_TOTAL() view returns (uint128)',
] as const;

export const CHAINLINK_AGGREGATOR_ABI = [
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function decimals() view returns (uint8)',
  'function description() view returns (string)',
] as const;

export const MULTICALL3_ABI = [
  'function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) payable returns (tuple(bool success, bytes returnData)[])',
  'function aggregate3Value(tuple(address target, bool allowFailure, uint256 value, bytes callData)[] calls) payable returns (tuple(bool success, bytes returnData)[])',
] as const;

export const ARBITRAGE_EXECUTOR_ABI = [
  'function executeArbitrage(tuple(address flashAsset, uint256 flashAmount, tuple(uint8 dexId, address tokenIn, address tokenOut, address pool, uint24 fee, uint256 minAmountOut, bytes extraData)[] steps, uint256 minReturnAmount, uint256 deadline) params)',
  'function simulateArbitrage(tuple(address flashAsset, uint256 flashAmount, tuple(uint8 dexId, address tokenIn, address tokenOut, address pool, uint24 fee, uint256 minAmountOut, bytes extraData)[] steps, uint256 minReturnAmount, uint256 deadline) params) view returns (uint256 expectedProfit, bool isProfitable)',
  'function authorizedExecutor() view returns (address)',
  'function minProfit() view returns (uint256)',
  'function owner() view returns (address)',
  'function rescueTokens(address,uint256)',
  'function updateAuthorizedExecutor(address)',
  'function updateMinProfit(uint256)',
  'event ArbitrageExecuted(address indexed executor, address indexed flashAsset, uint256 flashAmount, uint256 profit, uint256 gasUsed)',
] as const;