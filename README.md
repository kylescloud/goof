# Base Chain Multi-Strategy Aave V3 Flash Loan Arbitrage Bot

A fully autonomous, production-grade multi-strategy arbitrage bot deployed on **Base (Chain ID: 8453)**. The bot uses **Aave V3 flash loans** to source zero-upfront-capital liquidity, discovers live pools from all major Base DEX factory contracts, filters pools by Aave V3 borrowable asset membership, persists pool topology to disk, constructs arbitrage execution paths across multiple strategies, simulates profitability, and executes winning opportunities atomically via a custom Solidity smart contract.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                      Main Event Loop                         │
│  BlockListener → StrategyEngine → SimulationEngine → Exec   │
└─────────────────────────────────────────────────────────────┘
         │              │                │              │
    ┌────┴────┐   ┌─────┴─────┐   ┌─────┴─────┐  ┌───┴────┐
    │Provider │   │ Discovery │   │  Worker   │  │Circuit │
    │Manager  │   │  Engine   │   │  Pool     │  │Breaker │
    └─────────┘   └───────────┘   └───────────┘  └────────┘
         │              │                │              │
    ┌────┴────┐   ┌─────┴─────┐   ┌─────┴─────┐  ┌───┴────┐
    │Multicall│   │   Pool    │   │ On-Chain  │  │ Alert  │
    │Batcher  │   │ Registry  │   │ Simulator │  │Manager │
    └─────────┘   └───────────┘   └───────────┘  └────────┘
```

## Supported DEXes

| # | DEX | Type |
|---|-----|------|
| 1 | Uniswap V2 | V2 AMM |
| 2 | Uniswap V3 | V3 CLMM |
| 3 | SushiSwap V2 | V2 AMM |
| 4 | SushiSwap V3 | V3 CLMM |
| 5 | Aerodrome Finance | V2 AMM (Stable + Volatile) |
| 6 | Aerodrome Slipstream | V3 CLMM |
| 7 | BaseSwap V2 | V2 AMM |
| 8 | BaseSwap V3 | V3 CLMM |
| 9 | SwapBased | V2 AMM |
| 10 | PancakeSwap V3 | V3 CLMM |
| +  | 0x Aggregator | Aggregator |

## Arbitrage Strategies

1. **Two-Hop Cross-DEX** — Buy on DEX A, sell on DEX B
2. **Three-Hop Triangular** — A→B→C→A across three DEXes
3. **V2/V3 Same-Pair Divergence** — Exploit price gaps between V2 and V3 pools
4. **Stable Pair Exploitation** — Exploit stablecoin depeg events
5. **Liquidity Imbalance** — Large pool vs. small pool reserve ratio exploitation
6. **0x vs. Direct Route** — Compare aggregator quotes against direct DEX routes
7. **WETH Sandwich Route** — Multi-hop WETH intermediate arbitrage

## Prerequisites

- Node.js 20 LTS
- Foundry (forge, cast, anvil)
- A Base mainnet RPC endpoint (HTTP + WebSocket)
- An executor wallet funded with ETH for gas
- (Optional) 0x API key for Strategy 6
- (Optional) Telegram bot token for alerts

## Quick Start

### 1. Clone and Install

```bash
git clone <repo-url>
cd arbitrage-bot

# Install bot dependencies
cd bot && npm install && cd ..

# Install Foundry dependencies
cd contracts && forge install && cd ..
```

### 2. Configure Environment

```bash
cp .env.example .env
# Edit .env with your RPC URLs, private key, and other settings
```

### 3. Deploy the Smart Contract

```bash
cd contracts

# Deploy to Base mainnet
forge script script/Deploy.s.sol:DeployScript \
  --rpc-url $RPC_URL_PRIMARY \
  --broadcast \
  --verify \
  -vvvv

# Verify deployment
forge script script/VerifyDeployment.s.sol:VerifyDeploymentScript \
  --rpc-url $RPC_URL_PRIMARY \
  -vvvv
```

### 4. Build and Run the Bot

```bash
cd bot

# Build TypeScript
npm run build

# Run directly
npm start

# Or use PM2
cd ..
pm2 start ecosystem.config.js
```

### 5. Run Contract Tests

```bash
cd contracts

# Run all tests on a Base mainnet fork
forge test --fork-url $RPC_URL_PRIMARY -vvv

# Run with gas reporting
forge test --fork-url $RPC_URL_PRIMARY --gas-report

# Run specific test file
forge test --fork-url $RPC_URL_PRIMARY --match-path test/FlashLoanIntegration.t.sol -vvvv
```

## Monitoring

- **Logs:** `bot/logs/` directory with daily rotation
- **Metrics:** Prometheus endpoint at `http://localhost:9090/metrics`
- **Alerts:** Telegram notifications for critical events
- **PM2:** `pm2 monit` for process monitoring

## Configuration Reference

See `.env.example` for all configurable parameters with descriptions.

## Security Considerations

- The smart contract is immutable (no proxy pattern)
- Only the whitelisted executor address can trigger flash loans
- Reentrancy guard on all state-changing functions
- Deadline enforcement on all swap steps
- On-chain minimum profit enforcement
- Circuit breaker pauses execution after consecutive failures
- No delegatecall or selfdestruct

## License

MIT