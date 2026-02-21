// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IDexAdapter
 * @notice Solidity interface defining the on-chain swap routing signature for each DEX type.
 *         Used internally by ArbitrageExecutor to create a clean dispatch layer.
 */
interface IDexAdapter {
    /// @notice Executes a token swap on a specific DEX.
    /// @param tokenIn The input token address.
    /// @param tokenOut The output token address.
    /// @param amountIn The amount of input tokens to swap.
    /// @param minAmountOut The minimum acceptable output amount.
    /// @param pool The pool address to route through.
    /// @param fee The fee tier (V3) or 0 (V2).
    /// @param extraData DEX-specific encoded data.
    /// @return amountOut The actual amount of output tokens received.
    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        address pool,
        uint24 fee,
        bytes calldata extraData
    ) external returns (uint256 amountOut);

    /// @notice Gets a quote for a swap without executing it.
    /// @param tokenIn The input token address.
    /// @param tokenOut The output token address.
    /// @param amountIn The amount of input tokens.
    /// @param pool The pool address.
    /// @param fee The fee tier.
    /// @return amountOut The expected output amount.
    function getAmountOut(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        address pool,
        uint24 fee
    ) external view returns (uint256 amountOut);
}