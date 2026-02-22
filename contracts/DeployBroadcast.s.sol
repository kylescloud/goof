// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/ArbitrageExecutor.sol";

/**
 * @title DeployBroadcast
 * @notice Simplified deployment script that always broadcasts
 */
contract DeployBroadcast is Script {
    function run() external {
        // Hardcode values to avoid environment variable issues
        address AAVE_V3_POOL = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5;
        address EXECUTOR_ADDRESS = 0xd2Cb0846eE44729c25Db360739797eDa49f43A1d;
        uint256 minProfitUsd = 0;

        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");

        vm.startBroadcast(deployerPrivateKey);

        // V2 routers
        address[] memory v2Routers = new address[](4);
        v2Routers[0] = 0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24; // Uniswap V2
        v2Routers[1] = 0x6BDED42c6DA8FBf0d2bA55B2fa120C5e0c8D7891; // SushiSwap V2
        v2Routers[2] = 0x327Df1E6de05895d2ab08513aaDD9313Fe505d86; // BaseSwap V2
        v2Routers[3] = address(0); // SwapBased

        // V3 routers
        address[] memory v3Routers = new address[](5);
        v3Routers[0] = 0x2626664c2603336E57B271c5C0b26F421741e481; // Uniswap V3
        v3Routers[1] = 0xFB7eF66a7e61224DD6FcD0D7d9C3be5C8B049b9f; // SushiSwap V3
        v3Routers[2] = 0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5; // Aerodrome CL
        v3Routers[3] = 0x1B8eea9315bE495187D873DA7773a874545D9D48; // BaseSwap V3
        v3Routers[4] = 0x1b81D678ffb9C0263b24A97847620C99d213eB14; // PancakeSwap V3

        // V2 router IDs
        uint8[] memory v2RouterIds = new uint8[](4);
        v2RouterIds[0] = 0; // Uniswap V2
        v2RouterIds[1] = 2; // SushiSwap V2
        v2RouterIds[2] = 6; // BaseSwap V2
        v2RouterIds[3] = 8; // SwapBased

        // V3 router IDs
        uint8[] memory v3RouterIds = new uint8[](5);
        v3RouterIds[0] = 1; // Uniswap V3
        v3RouterIds[1] = 3; // SushiSwap V3
        v3RouterIds[2] = 5; // Aerodrome CL
        v3RouterIds[3] = 7; // BaseSwap V3
        v3RouterIds[4] = 9; // PancakeSwap V3

        // Deploy
        ArbitrageExecutor arbExecutor = new ArbitrageExecutor(
            AAVE_V3_POOL,
            EXECUTOR_ADDRESS,
            minProfitUsd,
            v2RouterIds,
            v2Routers,
            v3RouterIds,
            v3Routers
        );

        vm.stopBroadcast();

        console.log("=== ArbitrageExecutor Deployed ===");
        console.log("Address:", address(arbExecutor));
        console.log("Owner:", arbExecutor.owner());
        console.log("Executor:", arbExecutor.authorizedExecutor());
        console.log("Chain ID:", block.chainid);
    }
}