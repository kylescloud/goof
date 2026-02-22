#!/bin/bash

# Simple deployment script using cast to encode constructor args

echo "=== Deploying ArbitrageExecutor ==="

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

# Encode constructor arguments properly
CONSTRUCTOR_ARGS=$(cast abi-encode "constructor(address,address,uint256,uint8[],address[],uint8[],address[])" \
  0xA238Dd80C259a72e81d7e4664a9801593F98d1c5 \
  0xd2Cb0846eE44729c25Db360739797eDa49f43A1d \
  0 \
  0 \
  2 \
  6 \
  8 \
  0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24 \
  0x6BDED42c6DA8FBf0d2bA55B2fa120C5e0c8D7891 \
  0x327Df1E6de05895d2ab08513aaDD9313Fe505d86 \
  0x0000000000000000000000000000000000000000 \
  1 \
  3 \
  5 \
  7 \
  9 \
  0x2626664c2603336E57B271c5C0b26F421741e481 \
  0xFB7eF66a7e61224DD6FcD0D7d9C3be5C8B049b9f \
  0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5 \
  0x1B8eea9315bE495187D873DA7773a874545D9D48 \
  0x1b81D678ffb9C0263b24A97847620C99d213eB14)

echo "Constructor args: $CONSTRUCTOR_ARGS"

# Deploy
forge create \
  src/ArbitrageExecutor.sol:ArbitrageExecutor \
  --rpc-url "$BASE_RPC" \
  --private-key "$PRIVATE_KEY" \
  --constructor-args "$CONSTRUCTOR_ARGS" \
  --verify \
  --etherscan-api-key "$BASESCAN_API_KEY" \
  --chain-id 8453 \
  -vvv

echo ""
echo "=== Deployment Complete ==="