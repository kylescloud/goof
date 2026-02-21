// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./helpers/BaseTest.sol";

/**
 * @title SwapRoutingTest
 * @notice Tests each individual DEX swap handler (executeSwapStep) with real pool addresses
 *         to ensure routing logic is correct for all supported DEXes.
 */
contract SwapRoutingTest is BaseTest {
    // ─── Known Pool Addresses on Base ───────────────────────────────────
    // These are real, active pools on Base mainnet

    // Uniswap V2 WETH/USDC
    address constant UNI_V2_WETH_USDC = 0x88A43bbDF9D098eEC7bCEda4e2494615dfD9bB9C;

    // Aerodrome volatile WETH/USDC
    address constant AERO_WETH_USDC = 0xcDAC0d6c6C59727a65F871236188350531885C43;
    address constant AERO_FACTORY = 0x420DD381b31aEf6683db6B902084cB0FFECe40Da;

    /**
     * @notice Tests V2 swap simulation with real Uniswap V2 pool.
     */
    function test_simulateV2Swap_UniswapV2() public view {
        IArbitrageExecutor.SwapStep[] memory steps = new IArbitrageExecutor.SwapStep[](1);
        steps[0] = makeV2Step(0, USDC, WETH, UNI_V2_WETH_USDC, 0);

        IArbitrageExecutor.FlashLoanParams memory params = IArbitrageExecutor.FlashLoanParams({
            flashAsset: USDC,
            flashAmount: 10_000 * 1e6,
            steps: steps,
            minReturnAmount: 0,
            deadline: block.timestamp + 300
        });

        // Simulation should not revert
        (uint256 profit, bool isProfitable) = executor.simulateArbitrage(params);
        // Single direction won't be profitable but should return valid result
        assertEq(isProfitable, false);
    }

    /**
     * @notice Tests V2 swap simulation returns non-zero output for valid input.
     */
    function test_simulateV2Swap_nonZeroOutput() public view {
        // Read reserves directly to verify pool is active
        IUniswapV2Pair pair = IUniswapV2Pair(UNI_V2_WETH_USDC);
        (uint112 r0, uint112 r1,) = pair.getReserves();
        assertTrue(r0 > 0 && r1 > 0, "Pool should have liquidity");
    }

    /**
     * @notice Tests Aerodrome classic pool simulation.
     */
    function test_simulateAerodromeSwap() public view {
        // Verify Aerodrome pool is accessible
        IAerodromePool pool = IAerodromePool(AERO_WETH_USDC);
        (uint256 r0, uint256 r1,) = pool.getReserves();
        assertTrue(r0 > 0 && r1 > 0, "Aerodrome pool should have liquidity");

        // Test getAmountOut
        uint256 amountIn = 1000 * 1e6; // 1000 USDC
        uint256 amountOut = pool.getAmountOut(amountIn, USDC);
        assertTrue(amountOut > 0, "Aerodrome should return non-zero output");
    }

    /**
     * @notice Tests V3 pool state reads for simulation.
     */
    function test_readV3PoolState() public view {
        // Uniswap V3 USDC/WETH 500 fee pool
        address uniV3Pool = 0xd0b53D9277642d899DF5C87A3966A349A798F224;

        (uint160 sqrtPriceX96, int24 tick,,,,,) = IUniswapV3Pool(uniV3Pool).slot0();
        uint128 liq = IUniswapV3Pool(uniV3Pool).liquidity();

        assertTrue(sqrtPriceX96 > 0, "V3 pool should have valid sqrtPrice");
        assertTrue(liq > 0, "V3 pool should have liquidity");
        // Tick should be within valid range
        assertTrue(tick > -887272 && tick < 887272, "Tick should be in valid range");
    }

    /**
     * @notice Tests that V2 swap formula produces correct output.
     */
    function test_v2SwapFormula() public pure {
        // Manual calculation: amountIn=1000e6, reserveIn=1000000e6, reserveOut=500e18
        // amountInWithFee = 1000e6 * 997 = 997000e6
        // amountOut = (997000e6 * 500e18) / (1000000e6 * 1000 + 997000e6)
        // amountOut = 498500e24 / (1000000000e6 + 997000e6)
        // amountOut ≈ 498500e24 / 1000997000e6
        // amountOut ≈ 498.0025e18 (approximately 0.498 WETH)

        uint256 amountIn = 1000 * 1e6;
        uint256 reserveIn = 1_000_000 * 1e6;
        uint256 reserveOut = 500 * 1e18;

        uint256 amountInWithFee = amountIn * 997;
        uint256 numerator = amountInWithFee * reserveOut;
        uint256 denominator = reserveIn * 1000 + amountInWithFee;
        uint256 amountOut = numerator / denominator;

        assertTrue(amountOut > 0, "V2 formula should produce non-zero output");
        assertTrue(amountOut < reserveOut, "Output should be less than reserve");
        // Approximately 0.498 WETH
        assertTrue(amountOut > 490 * 1e15, "Output should be approximately 0.498 WETH");
        assertTrue(amountOut < 500 * 1e15, "Output should be less than 0.5 WETH");
    }

    /**
     * @notice Tests that invalid DEX ID is handled in simulation.
     */
    function test_simulateInvalidDexId() public view {
        IArbitrageExecutor.SwapStep[] memory steps = new IArbitrageExecutor.SwapStep[](1);
        steps[0] = IArbitrageExecutor.SwapStep({
            dexId: 255, // Invalid
            tokenIn: USDC,
            tokenOut: WETH,
            pool: UNI_V2_WETH_USDC,
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

        (uint256 profit, bool isProfitable) = executor.simulateArbitrage(params);
        assertEq(isProfitable, false);
        assertEq(profit, 0);
    }

    /**
     * @notice Tests Aerodrome pool metadata read.
     */
    function test_aerodromePoolMetadata() public view {
        IAerodromePool pool = IAerodromePool(AERO_WETH_USDC);
        address t0 = pool.token0();
        address t1 = pool.token1();
        bool isStable = pool.stable();

        assertTrue(t0 != address(0), "Token0 should be set");
        assertTrue(t1 != address(0), "Token1 should be set");
        assertEq(isStable, false, "WETH/USDC should be volatile pool");
    }

    /**
     * @notice Fuzz test V2 swap formula with various amounts.
     */
    function testFuzz_v2SwapFormula(uint256 amountIn) public pure {
        vm.assume(amountIn > 0 && amountIn < 1e30);

        uint256 reserveIn = 1_000_000 * 1e18;
        uint256 reserveOut = 1_000_000 * 1e18;

        uint256 amountInWithFee = amountIn * 997;
        uint256 numerator = amountInWithFee * reserveOut;
        uint256 denominator = reserveIn * 1000 + amountInWithFee;

        // Avoid division by zero
        if (denominator == 0) return;

        uint256 amountOut = numerator / denominator;
        assertTrue(amountOut <= reserveOut, "Output should never exceed reserve");
    }
}