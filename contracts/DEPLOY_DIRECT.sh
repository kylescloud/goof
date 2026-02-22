#!/bin/bash

# Direct deployment script for ArbitrageExecutor
# This bypasses the script file and deploys directly

echo "=== Deploying ArbitrageExecutor Contract ==="

# Check environment variables
if [ -z "$BASE_RPC" ]; then
    echo "Error: BASE_RPC not set"
    exit 1
fi

if [ -z "$PRIVATE_KEY" ]; then
    echo "Error: PRIVATE_KEY not set"
    exit 1
fi

if [ -z "$BASESCAN_API_KEY" ]; then
    echo "Error: BASESCAN_API_KEY not set"
    exit 1
fi

# Get EXECUTOR_ADDRESS from environment or use deployer address
EXECUTOR_ADDR=${EXECUTOR_ADDRESS:-$(cast wallet address --private-key $PRIVATE_KEY)}
echo "Executor Address: $EXECUTOR_ADDR"

# Deploy contract
echo "Deploying contract..."

forge create \
  src/ArbitrageExecutor.sol:ArbitrageExecutor \
  --rpc-url "$BASE_RPC" \
  --private-key "$PRIVATE_KEY" \
  --constructor-args \
    0xA238Dd80C259a72e81d7e4664a9801593F98d1c5 \
    $EXECUTOR_ADDR \
    0 \
    0x0002 \
    0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24 \
    0x6BDED42c6DA8FBf0d2bA55B2fa120C5e0c8D7891 \
    0x327Df1E6de05895d2ab08513aaDD9313Fe505d86 \
    0x0000000000000000000000000000000000000000 \
    0x0135 \
    0x2626664c2603336E57B271c5C0b26F421741e481 \
    0xFB7eF66a7e61224DD6FcD0D7d9C3be5C8B049b9f \
    0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5 \
    0x1B8eea9315bE495187D873DA7773a874545D9D48 \
    0x1b81D678ffb9C0263b24A97847620C99d213eB14 \
  --verify \
  --etherscan-api-key "$BASESCAN_API_KEY" \
  --chain-id 8453 \
  -vvv

echo ""
echo "=== Deployment Complete ==="
echo "Please check BaseScan to verify the contract"