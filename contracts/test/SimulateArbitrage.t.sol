// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./helpers/BaseTest.sol";

/**
 * @title SimulateArbitrageTest
 * @notice Tests the simulateArbitrage() view function in isolation to confirm
 *         it returns correct profit values before execution.
 */
contract SimulateArbitrageTest is BaseTest {
    // Known Uniswap V2 WETH/USDC pool on Base
    address constant UNI_V2_WETH_USDC = 0x88A43bbDF9D098eEC7bCEda4e2494615dfD9bB9C;

    function test_simulateV2SingleStep() public view {
        IArbitrageExecutor.SwapStep[] memory steps = new IArbitrageExecutor.SwapStep[](1);
        steps[0] = makeV2Step(
            0, // Uniswap V2
            USDC,
            WETH,
            UNI_V2_WETH_USDC,
            0
        );

        IArbitrageExecutor.FlashLoanParams memory params = IArbitrageExecutor.FlashLoanParams({
            flashAsset: USDC,
            flashAmount: 10_000 * 1e6,
            steps: steps,
            minReturnAmount: 0,
            deadline: block.timestamp + 300
        });

        (uint256 profit, bool isProfitable) = executor.simulateArbitrage(params);
        // Single step USDC->WETH won't return USDC, so not profitable for flash loan repayment
        // This validates the simulation runs without reverting
        assertEq(isProfitable, false);
        assertEq(profit, 0);
    }

    function test_simulateReturnsZeroForInvalidPool() public view {
        IArbitrageExecutor.SwapStep[] memory steps = new IArbitrageExecutor.SwapStep[](1);
        steps[0] = IArbitrageExecutor.SwapStep({
            dexId: 0,
            tokenIn: USDC,
            tokenOut: WETH,
            pool: address(0xdead), // Invalid pool
            fee: 0,
            minAmountOut: 0,
            extraData: ""
        });

        IArbitrageExecutor.FlashLoanParams memory params = IArbitrageExecutor.FlashLoanParams({
            flashAsset: USDC,
            flashAmount: 1000 * 1e6,
            steps: steps,
            minReturnAmount: 0,
            deadline: block.timestamp + 300
        });

        // Should return 0 profit and not revert
        (uint256 profit, bool isProfitable) = executor.simulateArbitrage(params);
        assertEq(isProfitable, false);
        assertEq(profit, 0);
    }

    function test_simulateWithZeroFlashAmount() public view {
        IArbitrageExecutor.SwapStep[] memory steps = new IArbitrageExecutor.SwapStep[](1);
        steps[0] = makeV2Step(0, USDC, WETH, UNI_V2_WETH_USDC, 0);

        IArbitrageExecutor.FlashLoanParams memory params = IArbitrageExecutor.FlashLoanParams({
            flashAsset: USDC,
            flashAmount: 0,
            steps: steps,
            minReturnAmount: 0,
            deadline: block.timestamp + 300
        });

        (uint256 profit, bool isProfitable) = executor.simulateArbitrage(params);
        assertEq(isProfitable, false);
        assertEq(profit, 0);
    }

    function test_simulateV3SingleStep() public view {
        // Uniswap V3 USDC/WETH 500 fee pool on Base
        address uniV3Pool = 0xd0b53D9277642d899DF5C87A3966A349A798F224;

        IArbitrageExecutor.SwapStep[] memory steps = new IArbitrageExecutor.SwapStep[](1);
        steps[0] = makeV3Step(
            1, // Uniswap V3
            USDC,
            WETH,
            uniV3Pool,
            500,
            0
        );

        IArbitrageExecutor.FlashLoanParams memory params = IArbitrageExecutor.FlashLoanParams({
            flashAsset: USDC,
            flashAmount: 10_000 * 1e6,
            steps: steps,
            minReturnAmount: 0,
            deadline: block.timestamp + 300
        });

        (uint256 profit, bool isProfitable) = executor.simulateArbitrage(params);
        // Single direction swap won't be profitable for repayment
        assertEq(isProfitable, false);
        assertEq(profit, 0);
    }

    function test_simulateMultipleSteps() public view {
        // Two-step simulation: USDC -> WETH -> USDC across different pools
        IArbitrageExecutor.SwapStep[] memory steps = new IArbitrageExecutor.SwapStep[](2);

        // Step 1: USDC -> WETH on Uniswap V2
        steps[0] = makeV2Step(0, USDC, WETH, UNI_V2_WETH_USDC, 0);

        // Step 2: WETH -> USDC on same pool (round trip, will lose to fees)
        steps[1] = makeV2Step(0, WETH, USDC, UNI_V2_WETH_USDC, 0);

        IArbitrageExecutor.FlashLoanParams memory params = IArbitrageExecutor.FlashLoanParams({
            flashAsset: USDC,
            flashAmount: 10_000 * 1e6,
            steps: steps,
            minReturnAmount: 0,
            deadline: block.timestamp + 300
        });

        (uint256 profit, bool isProfitable) = executor.simulateArbitrage(params);
        // Round trip on same pool will lose to fees, so not profitable
        assertEq(isProfitable, false);
        assertEq(profit, 0);
    }

    function test_simulate0xStep() public view {
        // 0x simulation uses minAmountOut as expected output
        IArbitrageExecutor.SwapStep[] memory steps = new IArbitrageExecutor.SwapStep[](1);
        steps[0] = IArbitrageExecutor.SwapStep({
            dexId: 10,
            tokenIn: USDC,
            tokenOut: WETH,
            pool: address(0),
            fee: 0,
            minAmountOut: 5 * 1e18, // Expect 5 WETH
            extraData: abi.encode(address(0), address(0), bytes(""))
        });

        IArbitrageExecutor.FlashLoanParams memory params = IArbitrageExecutor.FlashLoanParams({
            flashAsset: USDC,
            flashAmount: 10_000 * 1e6,
            steps: steps,
            minReturnAmount: 0,
            deadline: block.timestamp + 300
        });

        (uint256 profit, bool isProfitable) = executor.simulateArbitrage(params);
        // Returns WETH not USDC, so can't repay USDC flash loan
        assertEq(isProfitable, false);
    }

    function testFuzz_simulateFlashAmount(uint256 flashAmount) public view {
        vm.assume(flashAmount > 0 && flashAmount < 100_000_000 * 1e6); // Up to 100M USDC

        IArbitrageExecutor.SwapStep[] memory steps = new IArbitrageExecutor.SwapStep[](0);
        IArbitrageExecutor.FlashLoanParams memory params = IArbitrageExecutor.FlashLoanParams({
            flashAsset: USDC,
            flashAmount: flashAmount,
            steps: steps,
            minReturnAmount: 0,
            deadline: block.timestamp + 300
        });

        // Should never revert regardless of flash amount
        (uint256 profit, bool isProfitable) = executor.simulateArbitrage(params);
        // No steps means no swaps, so never profitable
        assertEq(isProfitable, false);
        assertEq(profit, 0);
    }
}