// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IUniswapV3Pool
 * @notice Interface for Uniswap V3 pool state reads and swap execution.
 */
interface IUniswapV3Pool {
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
     * @return feeProtocol The protocol fee for both tokens.
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
            uint8 feeProtocol,
            bool unlocked
        );

    /// @notice Returns the current in-range liquidity.
    function liquidity() external view returns (uint128);

    /// @notice Returns the pool's token0 address.
    function token0() external view returns (address);

    /// @notice Returns the pool's token1 address.
    function token1() external view returns (address);

    /// @notice Returns the pool's fee in hundredths of a bip (e.g., 3000 = 0.3%).
    function fee() external view returns (uint24);

    /// @notice Returns the pool's tick spacing.
    function tickSpacing() external view returns (int24);

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
     * @param amountSpecified The amount of the swap (positive = exact input, negative = exact output).
     * @param sqrtPriceLimitX96 The price limit for the swap.
     * @param data Callback data passed to the swap callback.
     * @return amount0 The delta of token0 balance of the pool.
     * @return amount1 The delta of token1 balance of the pool.
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
}

/**
 * @title IUniswapV3Factory
 * @notice Interface for the Uniswap V3 factory for pool creation event filtering.
 */
interface IUniswapV3Factory {
    /// @notice Emitted when a pool is created.
    event PoolCreated(
        address indexed token0,
        address indexed token1,
        uint24 indexed fee,
        int24 tickSpacing,
        address pool
    );

    /**
     * @notice Returns the pool address for a given pair of tokens and fee tier.
     * @param tokenA First token address.
     * @param tokenB Second token address.
     * @param fee The fee tier.
     * @return pool The pool address.
     */
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
}