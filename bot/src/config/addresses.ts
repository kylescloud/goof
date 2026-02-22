/**
 * @file addresses.ts
 * @description Canonical Base mainnet address registry. Contains all DEX factory addresses,
 *              router addresses, quoter addresses, Aave V3 addresses, Chainlink feed addresses,
 *              and all supported ERC20 token addresses with their metadata.
 */

export interface TokenInfo {
  address: string;
  symbol: string;
  decimals: number;
}

export interface DexAddresses {
  factory: string;
  router: string;
  quoter?: string;
}

export interface ChainlinkFeed {
  address: string;
  decimals: number;
  description: string;
}

// ─── Chain Configuration ────────────────────────────────────────────────
export const CHAIN_ID = 8453;
export const CHAIN_NAME = 'Base';

// ─── Core Protocol Addresses ────────────────────────────────────────────
export const AAVE_V3 = {
  pool: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
  poolAddressesProvider: '0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D',
  oracle: '0x2Cc0Fc26eD4563A5ce5e8bdcfe1A2878676Ae156',
} as const;

export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';

// ─── Token Addresses ────────────────────────────────────────────────────
export const TOKENS: Record<string, TokenInfo> = {
  WETH: {
    address: '0x4200000000000000000000000000000000000006',
    symbol: 'WETH',
    decimals: 18,
  },
  USDC: {
    address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    symbol: 'USDC',
    decimals: 6,
  },
  USDbC: {
    address: '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA',
    symbol: 'USDbC',
    decimals: 6,
  },
  DAI: {
    address: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb',
    symbol: 'DAI',
    decimals: 18,
  },
  USDT: {
    address: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2',
    symbol: 'USDT',
    decimals: 6,
  },
  cbETH: {
    address: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22',
    symbol: 'cbETH',
    decimals: 18,
  },
  wstETH: {
    address: '0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452',
    symbol: 'wstETH',
    decimals: 18,
  },
  rETH: {
    address: '0xB6fe221Fe9EeF5aBa221c348bA20A1Bf5e73624c',
    symbol: 'rETH',
    decimals: 18,
  },
  cbBTC: {
    address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf',
    symbol: 'cbBTC',
    decimals: 8,
  },
  WBTC: {
    address: '0x0555E30da8f98308EdB960aa94C0Db47230d2B9c',
    symbol: 'WBTC',
    decimals: 8,
  },
  // ─── New Aave V3 flash loan assets ───
  weETH: {
    address: '0x04C0599Ae5A44757c0af6F9eC3b93da8976c150A',
    symbol: 'weETH',
    decimals: 18,
  },
  ezETH: {
    address: '0x2416092f143378750bb29b79eD961ab195CcEea5',
    symbol: 'ezETH',
    decimals: 18,
  },
  GHO: {
    address: '0x6Bb7a212910682DCFdbd5BCBb3e28FB4E8da10Ee',
    symbol: 'GHO',
    decimals: 18,
  },
  wrsETH: {
    address: '0xEDfa23602D0EC14714057867A78d01e94176BEA0',
    symbol: 'wrsETH',
    decimals: 18,
  },
  EURC: {
    address: '0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42',
    symbol: 'EURC',
    decimals: 6,
  },
  AERO: {
    address: '0x940181a94A35A4569E4529A3CDfB74e38FD98631',
    symbol: 'AERO',
    decimals: 18,
  },
  tBTC: {
    address: '0x236aa50979D5f3De3Bd1Eeb40E81137F22ab794b',
    symbol: 'tBTC',
    decimals: 18,
  },
  // ─── High-volume non-Aave tokens for routing ───
  DEGEN: {
    address: '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed',
    symbol: 'DEGEN',
    decimals: 18,
  },
  BRETT: {
    address: '0x532f27101965dd16442E59d40670FaF5eBB142E4',
    symbol: 'BRETT',
    decimals: 18,
  },
  TOSHI: {
    address: '0xAC1Bd2486aAf3B5C0fc3Fd868558b082a531B2B4',
    symbol: 'TOSHI',
    decimals: 18,
  },
  WELL: {
    address: '0xA88594D404727625A9437C3f886C7643872296AE',
    symbol: 'WELL',
    decimals: 18,
  },
} as const;

// Build reverse lookup: address -> TokenInfo
export const TOKEN_BY_ADDRESS: Record<string, TokenInfo> = {};
for (const [, info] of Object.entries(TOKENS)) {
  TOKEN_BY_ADDRESS[info.address.toLowerCase()] = info;
}

// Stablecoin addresses for Strategy 4
export const STABLECOINS: string[] = [
  TOKENS.USDC.address,
  TOKENS.USDbC.address,
  TOKENS.USDT.address,
  TOKENS.DAI.address,
  TOKENS.EURC.address,
  TOKENS.GHO.address,
];

// ─── DEX Addresses ──────────────────────────────────────────────────────

export const DEX_ADDRESSES = {
  // 0: Uniswap V2
  uniswapV2: {
    factory: '0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6',
    router: '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24',
  } as DexAddresses,

  // 1: Uniswap V3
  uniswapV3: {
    factory: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
    router: '0x2626664c2603336E57B271c5C0b26F421741e481',
    quoter: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
  } as DexAddresses,

  // 2: SushiSwap V2
  sushiswapV2: {
    factory: '0x71524B4f93c58fcbF659783284e38825f0622859',
    router: '0x6BDED42c6DA8FBf0d2bA55B2fa120C5e0c8D7891',
  } as DexAddresses,

  // 3: SushiSwap V3
  sushiswapV3: {
    factory: '0xc35DADB65012eC5796536bD9864eD8773aBc74C4',
    router: '0xFB7eF66a7e61224DD6FcD0D7d9C3be5C8B049b9f',
    quoter: '0xb1E835Dc2785b52265711e17fCCb0fd018226a6e',
  } as DexAddresses,

  // 4: Aerodrome Finance (classic)
  aerodrome: {
    factory: '0x420DD381b31aEf6683db6B902084cB0FFECe40Da',
    router: '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43',
  } as DexAddresses,

  // 5: Aerodrome Slipstream (CL)
  aerodromeSlipstream: {
    factory: '0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A',
    router: '0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5',
    quoter: '0x254cF9E1E6e233aa1AC962CB9B05b2cfeAaE15b0',
  } as DexAddresses,

  // 6: BaseSwap V2
  baseswapV2: {
    factory: '0xFDa619b6d20975be80A10332cD39b9a4b0FAa8BB',
    router: '0x327Df1E6de05895d2ab08513aaDD9313Fe505d86',
  } as DexAddresses,

  // 7: BaseSwap V3
  baseswapV3: {
    factory: '0x38015D05f4fEC8AFe15D7cc0386a126574e8077B',
    router: '0x1B8eea9315bE495187D873DA7773a874545D9D48',
    quoter: '0x4fDBD73aD4B1DDde594BF05497C15f76308eFfb9',
  } as DexAddresses,

  // 8: SwapBased
  swapBased: {
    factory: '0x04C9f118d21e8B767D2e50C946f0cC9F6C367300',
    router: '0xaaa3b1F1bd7BCc97fD1917c18ADE665C5D31F066',
  } as DexAddresses,

  // 9: PancakeSwap V3
  pancakeswapV3: {
    factory: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865',
    router: '0x1b81D678ffb9C0263b24A97847620C99d213eB14',
    quoter: '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997',
  } as DexAddresses,
} as const;

// ─── DEX Factory Deployment Blocks ──────────────────────────────────────
// Used by the discovery engine to know where to start scanning for events
export const DEX_FACTORY_DEPLOY_BLOCKS: Record<string, number> = {
  uniswapV2: 2_337_971,
  uniswapV3: 2_101_816,
  sushiswapV2: 2_798_223,
  sushiswapV3: 3_227_767,
  aerodrome: 2_695_255,
  aerodromeSlipstream: 11_894_647,
  baseswapV2: 2_057_199,
  baseswapV3: 4_215_521,
  swapBased: 2_607_341,
  pancakeswapV3: 2_584_004,
};

// ─── Chainlink Price Feed Addresses (Base) ──────────────────────────────
export const CHAINLINK_FEEDS: Record<string, ChainlinkFeed> = {
  'ETH/USD': {
    address: '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70',
    decimals: 8,
    description: 'ETH / USD',
  },
  'BTC/USD': {
    address: '0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F',
    decimals: 8,
    description: 'BTC / USD',
  },
  'USDC/USD': {
    address: '0x7e860098F58bBFC8648a4311b374B1D669a2bc6B',
    decimals: 8,
    description: 'USDC / USD',
  },
  'DAI/USD': {
    address: '0x591e79239a7d679378eC8c847e5038150364C78F',
    decimals: 8,
    description: 'DAI / USD',
  },
  'USDT/USD': {
    address: '0xf19d560eB8d2ADf07BD6D13ed03e1D11215721F9',
    decimals: 8,
    description: 'USDT / USD',
  },
  // NOTE: cbETH/USD, wstETH/USD, rETH/USD direct feeds are not reliably available on Base.
  // OracleRegistry derives these prices from cbETH/ETH ratio * ETH/USD price.
  'cbETH/ETH': {
    address: '0x806b4Ac04501c29769051e42783cF04dCE41440b',
    decimals: 18,
    description: 'cbETH / ETH',
  },
};

// Token address to Chainlink feed mapping
// Only include feeds that are verified working on Base mainnet.
// cbETH/wstETH/rETH prices are derived in OracleRegistry from ETH price + ratio.
export const TOKEN_TO_FEED: Record<string, string> = {
  [TOKENS.WETH.address.toLowerCase()]:  CHAINLINK_FEEDS['ETH/USD'].address,
  [TOKENS.USDC.address.toLowerCase()]:  CHAINLINK_FEEDS['USDC/USD'].address,
  [TOKENS.USDbC.address.toLowerCase()]: CHAINLINK_FEEDS['USDC/USD'].address,
  [TOKENS.DAI.address.toLowerCase()]:   CHAINLINK_FEEDS['DAI/USD'].address,
  [TOKENS.USDT.address.toLowerCase()]:  CHAINLINK_FEEDS['USDT/USD'].address,
  [TOKENS.cbBTC.address.toLowerCase()]: CHAINLINK_FEEDS['BTC/USD'].address,
  [TOKENS.WBTC.address.toLowerCase()]:  CHAINLINK_FEEDS['BTC/USD'].address,
  // cbETH/wstETH/rETH: derived in OracleRegistry, no direct USD feed registered here
};

// ─── 0x Protocol Addresses ──────────────────────────────────────────────
export const ZERO_X = {
  exchangeProxy: '0xDef1C0ded9bec7F1a1670819833240f027b25EfF',
  baseApiUrl: 'https://base.api.0x.org',
} as const;