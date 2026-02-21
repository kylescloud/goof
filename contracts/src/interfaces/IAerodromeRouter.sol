// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IAerodromeRouter
 * @notice Interface for the Aerodrome Finance router on Base.
 *         Handles both stable and volatile pool swaps using the Route struct format.
 */
interface IAerodromeRouter {
    /// @notice Represents a single route step for Aerodrome swaps.
    struct Route {
        /// @dev The input token address.
        address from;
        /// @dev The output token address.
        address to;
        /// @dev True if the pool is a stable pool, false if volatile.
        bool stable;
        /// @dev The factory address that created the pool (address(0) for default).
        address factory;
    }

    /**
     * @notice Swaps an exact amount of input tokens for as many output tokens as possible,
     *         along the route determined by the path.
     * @param amountIn The amount of input tokens to send.
     * @param amountOutMin The minimum amount of output tokens to receive.
     * @param routes An array of Route structs defining the swap path.
     * @param to The recipient of the output tokens.
     * @param deadline Unix timestamp after which the transaction will revert.
     * @return amounts The amounts of tokens for each step of the swap.
     */
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        Route[] calldata routes,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);

    /**
     * @notice Returns the output amount for a given input amount and route.
     * @param amountIn The input amount.
     * @param tokenIn The input token address.
     * @param tokenOut The output token address.
     * @return stable Whether the optimal route uses a stable pool.
     * @return amountOut The expected output amount.
     */
    function getAmountOut(uint256 amountIn, address tokenIn, address tokenOut)
        external
        view
        returns (bool stable, uint256 amountOut);

    /**
     * @notice Returns the output amounts for a given input amount along a route.
     * @param amountIn The input amount.
     * @param routes The route to quote.
     * @return amounts The output amounts for each step.
     */
    function getAmountsOut(uint256 amountIn, Route[] calldata routes)
        external
        view
        returns (uint256[] memory amounts);

    /// @notice Returns the factory address used by this router.
    function defaultFactory() external view returns (address);

    /// @notice Returns the WETH address.
    function weth() external view returns (address);

    /**
     * @notice Returns the pool address for a given pair and stability type.
     * @param tokenA First token address.
     * @param tokenB Second token address.
     * @param stable Whether to query the stable or volatile pool.
     * @param _factory The factory address.
     * @return pool The pool address.
     */
    function poolFor(address tokenA, address tokenB, bool stable, address _factory)
        external
        view
        returns (address pool);
}

/**
 * @title IAerodromeFactory
 * @notice Interface for the Aerodrome classic pool factory.
 */
interface IAerodromeFactory {
    /// @notice Emitted when a new pool is created.
    event PoolCreated(address indexed token0, address indexed token1, bool indexed stable, address pool, uint256);

    /// @notice Returns the pool address for a given pair and stability type.
    function getPool(address tokenA, address tokenB, bool stable) external view returns (address);

    /// @notice Returns the pool at the given index.
    function allPools(uint256 index) external view returns (address);

    /// @notice Returns the total number of pools.
    function allPoolsLength() external view returns (uint256);

    /// @notice Returns whether the given address is a valid pool.
    function isPool(address pool) external view returns (bool);
}