// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IAerodromeCLPool
 * @notice Interface for Aerodrome Slipstream concentrated liquidity (CL) pools.
 *         Similar to Uniswap V3 pools but uses tick spacing instead of fee tiers.
 */
interface IAerodromeCLPool {
    /// @notice Emitted on each swap.
    event Swap(
        address indexed sender,
        address indexed recipient,
        int256 amount0,
        int256 amount1,
        uint160 sqrtPriceX96,
        uint128 liquidity,
        int24 tick
    );

    /**
     * @notice Returns the current price and tick data for the pool.
     * @return sqrtPriceX96 The current sqrt(price) as a Q64.96 value.
     * @return tick The current tick.
     * @return observationIndex The index of the last oracle observation.
     * @return observationCardinality The current maximum number of observations stored.
     * @return observationCardinalityNext The next maximum number of observations.
     * @return unlocked Whether the pool is currently unlocked.
     */
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            bool unlocked
        );

    /// @notice Returns the current in-range liquidity.
    function liquidity() external view returns (uint128);

    /// @notice Returns the pool's token0 address.
    function token0() external view returns (address);

    /// @notice Returns the pool's token1 address.
    function token1() external view returns (address);

    /// @notice Returns the pool's tick spacing.
    function tickSpacing() external view returns (int24);

    /// @notice Returns the pool's fee in hundredths of a bip.
    function fee() external view returns (uint24);

    /**
     * @notice Returns the tick data for a given tick.
     * @param tick The tick to query.
     * @return liquidityGross Total liquidity referencing this tick.
     * @return liquidityNet Net liquidity change when tick is crossed.
     * @return feeGrowthOutside0X128 Fee growth of token0 outside the tick.
     * @return feeGrowthOutside1X128 Fee growth of token1 outside the tick.
     * @return tickCumulativeOutside Cumulative tick value outside the tick.
     * @return secondsPerLiquidityOutsideX128 Seconds per liquidity outside the tick.
     * @return secondsOutside Seconds outside the tick.
     * @return initialized Whether the tick is initialized.
     */
    function ticks(int24 tick)
        external
        view
        returns (
            uint128 liquidityGross,
            int128 liquidityNet,
            uint256 feeGrowthOutside0X128,
            uint256 feeGrowthOutside1X128,
            int56 tickCumulativeOutside,
            uint160 secondsPerLiquidityOutsideX128,
            uint32 secondsOutside,
            bool initialized
        );

    /**
     * @notice Executes a swap against the pool.
     * @param recipient The address to receive the output tokens.
     * @param zeroForOne True if swapping token0 for token1, false otherwise.
     * @param amountSpecified The amount of the swap.
     * @param sqrtPriceLimitX96 The price limit for the swap.
     * @param data Callback data passed to the swap callback.
     * @return amount0 The delta of token0 balance.
     * @return amount1 The delta of token1 balance.
     */
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);

    /// @notice Returns the factory address that created this pool.
    function factory() external view returns (address);

    /// @notice Returns the gauge address for this pool.
    function gauge() external view returns (address);
}

/**
 * @title IAerodromeCLFactory
 * @notice Interface for the Aerodrome Slipstream CL factory.
 */
interface IAerodromeCLFactory {
    /// @notice Emitted when a pool is created.
    event PoolCreated(address indexed token0, address indexed token1, int24 indexed tickSpacing, address pool);

    /**
     * @notice Returns the pool address for a given pair and tick spacing.
     * @param tokenA First token address.
     * @param tokenB Second token address.
     * @param tickSpacing The tick spacing.
     * @return pool The pool address.
     */
    function getPool(address tokenA, address tokenB, int24 tickSpacing) external view returns (address pool);

    /// @notice Returns all tick spacings that have been enabled.
    function tickSpacings() external view returns (int24[] memory);
}

/**
 * @title IAerodromeCLRouter
 * @notice Interface for the Aerodrome Slipstream CL swap router.
 */
interface IAerodromeCLRouter {
    /// @notice Parameters for a single-hop exact input swap on Slipstream.
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        int24 tickSpacing;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    /// @notice Parameters for a multi-hop exact input swap on Slipstream.
    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    /**
     * @notice Swaps `amountIn` of one token for as much as possible of another (single hop).
     * @param params The parameters necessary for the swap.
     * @return amountOut The amount of the received token.
     */
    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);

    /**
     * @notice Swaps `amountIn` of one token for as much as possible of another along the path.
     * @param params The parameters necessary for the multi-hop swap.
     * @return amountOut The amount of the received token.
     */
    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}

/**
 * @title IAerodromeCLQuoter
 * @notice Interface for the Aerodrome Slipstream quoter.
 */
interface IAerodromeCLQuoter {
    /// @notice Parameters for quoting a single-hop exact input swap.
    struct QuoteExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        int24 tickSpacing;
        uint160 sqrtPriceLimitX96;
    }

    /**
     * @notice Returns the amount out for a given exact input single swap.
     * @param params The quote parameters.
     * @return amountOut The expected output amount.
     * @return sqrtPriceX96After The sqrt price after the swap.
     * @return initializedTicksCrossed The number of initialized ticks crossed.
     * @return gasEstimate The estimated gas.
     */
    function quoteExactInputSingle(QuoteExactInputSingleParams memory params)
        external
        returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate);
}