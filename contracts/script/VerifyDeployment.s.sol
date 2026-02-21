// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/ArbitrageExecutor.sol";
import "../src/interfaces/IAaveV3Pool.sol";
import "../src/interfaces/IArbitrageExecutor.sol";

/**
 * @title VerifyDeploymentScript
 * @notice Post-deploy verification script. Reads deployments.json, calls all view functions
 *         on the deployed contract to confirm state is correct, and emits a verification report.
 */
contract VerifyDeploymentScript is Script {
    address constant AAVE_V3_POOL = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5;
    address constant UNISWAP_V2_ROUTER = 0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24;
    address constant UNISWAP_V3_ROUTER = 0x2626664c2603336E57B271c5C0b26F421741e481;
    address constant SUSHISWAP_V2_ROUTER = 0x6BDED42c6DA8FBf0d2bA55B2fa120C5e0c8D7891;
    address constant SUSHISWAP_V3_ROUTER = 0xFB7eF66a7e61224DD6FcD0D7d9C3be5C8B049b9f;
    address constant AERODROME_CL_ROUTER = 0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5;
    address constant BASESWAP_V2_ROUTER = 0x327Df1E6de05895d2ab08513aaDD9313Fe505d86;
    address constant BASESWAP_V3_ROUTER = 0x1B8eea9315bE495187D873DA7773a874545D9D48;
    address constant PANCAKESWAP_V3_ROUTER = 0x1b81D678ffb9C0263b24A97847620C99d213eB14;

    function run() external view {
        address deployedAddress = vm.envAddress("ARBITRAGE_EXECUTOR_ADDRESS");
        ArbitrageExecutor executor = ArbitrageExecutor(payable(deployedAddress));

        console.log("=== Deployment Verification Report ===");
        console.log("Contract Address:", deployedAddress);
        console.log("");

        // 1. Verify immutable state
        console.log("--- Immutable State ---");
        address aavePool = executor.AAVE_POOL();
        console.log("Aave Pool:", aavePool);
        _check("Aave Pool matches", aavePool == AAVE_V3_POOL);

        // 2. Verify owner and executor
        console.log("");
        console.log("--- Access Control ---");
        address currentOwner = executor.owner();
        address currentExecutor = executor.authorizedExecutor();
        console.log("Owner:", currentOwner);
        console.log("Authorized Executor:", currentExecutor);
        _check("Owner is non-zero", currentOwner != address(0));
        _check("Executor is non-zero", currentExecutor != address(0));

        // 3. Verify min profit
        console.log("");
        console.log("--- Configuration ---");
        uint256 currentMinProfit = executor.minProfit();
        console.log("Min Profit:", currentMinProfit);

        // 4. Verify V2 routers
        console.log("");
        console.log("--- V2 Routers ---");
        address uniV2 = executor.v2Routers(0);
        address sushiV2 = executor.v2Routers(2);
        address baseswapV2 = executor.v2Routers(6);
        console.log("Uniswap V2 Router:", uniV2);
        console.log("SushiSwap V2 Router:", sushiV2);
        console.log("BaseSwap V2 Router:", baseswapV2);
        _check("Uniswap V2 Router matches", uniV2 == UNISWAP_V2_ROUTER);
        _check("SushiSwap V2 Router matches", sushiV2 == SUSHISWAP_V2_ROUTER);
        _check("BaseSwap V2 Router matches", baseswapV2 == BASESWAP_V2_ROUTER);

        // 5. Verify V3 routers
        console.log("");
        console.log("--- V3 Routers ---");
        address uniV3 = executor.v3Routers(1);
        address sushiV3 = executor.v3Routers(3);
        address aeroCL = executor.v3Routers(5);
        address baseswapV3 = executor.v3Routers(7);
        address pancakeV3 = executor.v3Routers(9);
        console.log("Uniswap V3 Router:", uniV3);
        console.log("SushiSwap V3 Router:", sushiV3);
        console.log("Aerodrome CL Router:", aeroCL);
        console.log("BaseSwap V3 Router:", baseswapV3);
        console.log("PancakeSwap V3 Router:", pancakeV3);
        _check("Uniswap V3 Router matches", uniV3 == UNISWAP_V3_ROUTER);
        _check("SushiSwap V3 Router matches", sushiV3 == SUSHISWAP_V3_ROUTER);
        _check("Aerodrome CL Router matches", aeroCL == AERODROME_CL_ROUTER);
        _check("BaseSwap V3 Router matches", baseswapV3 == BASESWAP_V3_ROUTER);
        _check("PancakeSwap V3 Router matches", pancakeV3 == PANCAKESWAP_V3_ROUTER);

        // 6. Verify Aave V3 Pool is accessible
        console.log("");
        console.log("--- Aave V3 Pool Verification ---");
        IAaveV3Pool pool = IAaveV3Pool(AAVE_V3_POOL);
        address[] memory reserves = pool.getReservesList();
        console.log("Aave reserves count:", reserves.length);
        _check("Aave has reserves", reserves.length > 0);

        uint128 premium = pool.FLASHLOAN_PREMIUM_TOTAL();
        console.log("Flash loan premium (bps):", uint256(premium));
        _check("Premium is reasonable", premium <= 100);

        // 7. Verify simulation works
        console.log("");
        console.log("--- Simulation Verification ---");
        IArbitrageExecutor.SwapStep[] memory steps = new IArbitrageExecutor.SwapStep[](0);
        IArbitrageExecutor.FlashLoanParams memory params = IArbitrageExecutor.FlashLoanParams({
            flashAsset: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913, // USDC
            flashAmount: 1000 * 1e6,
            steps: steps,
            minReturnAmount: 0,
            deadline: block.timestamp + 300
        });

        (uint256 profit, bool isProfitable) = executor.simulateArbitrage(params);
        console.log("Simulation profit:", profit);
        console.log("Simulation profitable:", isProfitable);
        _check("Simulation runs without revert", true);

        // 8. Verify contract has code
        console.log("");
        console.log("--- Contract Code Verification ---");
        uint256 codeSize;
        assembly {
            codeSize := extcodesize(deployedAddress)
        }
        console.log("Contract code size:", codeSize);
        _check("Contract has code", codeSize > 0);

        console.log("");
        console.log("=== Verification Complete ===");
    }

    function _check(string memory label, bool condition) internal pure {
        if (condition) {
            console.log(string(abi.encodePacked("  [PASS] ", label)));
        } else {
            console.log(string(abi.encodePacked("  [FAIL] ", label)));
        }
    }
}