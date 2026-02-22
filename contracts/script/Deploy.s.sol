// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/ArbitrageExecutor.sol";

/**
 * @title DeployScript
 * @notice Foundry deployment script for ArbitrageExecutor on Base mainnet.
 *         Deploys the contract, sets authorized executor, sets minProfit,
 *         and saves the deployed address to deployments.json.
 */
contract DeployScript is Script {
    // ─── Base Mainnet Addresses ─────────────────────────────────────────
    address constant AAVE_V3_POOL = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5;

    // V2 Routers
    address constant UNISWAP_V2_ROUTER = 0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24;
    address constant SUSHISWAP_V2_ROUTER = 0x6BDED42c6DA8FBf0d2bA55B2fa120C5e0c8D7891;
    address constant BASESWAP_V2_ROUTER = 0x327Df1E6de05895d2ab08513aaDD9313Fe505d86;

    // V3 Routers
    address constant UNISWAP_V3_ROUTER = 0x2626664c2603336E57B271c5C0b26F421741e481;
    address constant SUSHISWAP_V3_ROUTER = 0xFB7eF66a7e61224DD6FcD0D7d9C3be5C8B049b9f;
    address constant AERODROME_CL_ROUTER = 0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5;
    address constant BASESWAP_V3_ROUTER = 0x1B8eea9315bE495187D873DA7773a874545D9D48;
    address constant PANCAKESWAP_V3_ROUTER = 0x1b81D678ffb9C0263b24A97847620C99d213eB14;

    function run() external {
        // Load environment variables
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address executorEOA = vm.envAddress("EXECUTOR_ADDRESS");
        uint256 minProfitUsd = vm.envOr("MIN_PROFIT_AMOUNT", uint256(0));

        vm.startBroadcast(deployerPrivateKey);

        // Build V2 router arrays
        uint8[] memory v2Ids = new uint8[](4);
        address[] memory v2Addrs = new address[](4);
        v2Ids[0] = 0; v2Addrs[0] = UNISWAP_V2_ROUTER;      // Uniswap V2
        v2Ids[1] = 2; v2Addrs[1] = SUSHISWAP_V2_ROUTER;     // SushiSwap V2
        v2Ids[2] = 6; v2Addrs[2] = BASESWAP_V2_ROUTER;      // BaseSwap V2
        v2Ids[3] = 8; v2Addrs[3] = address(0);               // SwapBased (direct pair)

        // Build V3 router arrays
        uint8[] memory v3Ids = new uint8[](5);
        address[] memory v3Addrs = new address[](5);
        v3Ids[0] = 1; v3Addrs[0] = UNISWAP_V3_ROUTER;       // Uniswap V3
        v3Ids[1] = 3; v3Addrs[1] = SUSHISWAP_V3_ROUTER;     // SushiSwap V3
        v3Ids[2] = 5; v3Addrs[2] = AERODROME_CL_ROUTER;     // Aerodrome Slipstream
        v3Ids[3] = 7; v3Addrs[3] = BASESWAP_V3_ROUTER;      // BaseSwap V3
        v3Ids[4] = 9; v3Addrs[4] = PANCAKESWAP_V3_ROUTER;   // PancakeSwap V3

        // Deploy
        ArbitrageExecutor arbExecutor = new ArbitrageExecutor(
            AAVE_V3_POOL,
            executorEOA,
            minProfitUsd,
            v2Ids,
            v2Addrs,
            v3Ids,
            v3Addrs
        );

        vm.stopBroadcast();

        // Log deployment info
        console.log("=== ArbitrageExecutor Deployed ===");
        console.log("Address:", address(arbExecutor));
        console.log("Owner:", arbExecutor.owner());
        console.log("Executor:", arbExecutor.authorizedExecutor());
        console.log("Min Profit:", arbExecutor.minProfit());
        console.log("Aave Pool:", arbExecutor.AAVE_POOL());
        console.log("Chain ID:", block.chainid);

        // Write deployment info to JSON
        string memory json = string(abi.encodePacked(
            '{"chainId":', vm.toString(block.chainid),
            ',"arbitrageExecutor":"', vm.toString(address(arbExecutor)),
            '","owner":"', vm.toString(arbExecutor.owner()),
            '","executor":"', vm.toString(executorEOA),
            '","aavePool":"', vm.toString(AAVE_V3_POOL),
            '","minProfit":', vm.toString(minProfitUsd),
            ',"blockNumber":', vm.toString(block.number),
            ',"timestamp":', vm.toString(block.timestamp),
            '}'
        ));

        // Note: vm.writeFile may fail in broadcast mode, but deployment is successful
        try vm.writeFile("deployments.json", json) {
            console.log("Deployment info saved to deployments.json");
        } catch {
            console.log("Note: Could not write deployment.json (security restriction)");
        }
    }
}