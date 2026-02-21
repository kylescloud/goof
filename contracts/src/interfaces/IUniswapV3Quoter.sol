// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IUniswapV3Quoter
 * @notice Interface for the Uniswap V3 Quoter V2 for off-chain quote estimation.
 */
interface IUniswapV3Quoter {
    /// @notice Parameters for quoting a single-hop exact input swap.
    struct QuoteExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint24 fee;
        uint160 sqrtPriceLimitX96;
    }

    /**
     * @notice Returns the amount out received for a given exact input swap without executing the swap.
     * @param params The params for the quote (tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96).
     * @return amountOut The amount of `tokenOut` that would be received.
     * @return sqrtPriceX96After The sqrt price after the swap.
     * @return initializedTicksCrossed The number of initialized ticks crossed.
     * @return gasEstimate The estimated gas for the swap.
     */
    function quoteExactInputSingle(QuoteExactInputSingleParams memory params)
        external
        returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate);

    /**
     * @notice Returns the amount out received for a given exact input multi-hop swap.
     * @param path The encoded swap path (tokenIn, fee, tokenMid, fee, tokenOut, ...).
     * @param amountIn The amount of the first token to swap.
     * @return amountOut The amount of the last token that would be received.
     * @return sqrtPriceX96AfterList The sqrt prices after each pool swap in the path.
     * @return initializedTicksCrossedList The number of initialized ticks crossed for each pool.
     * @return gasEstimate The estimated gas for the entire swap.
     */
    function quoteExactInput(bytes memory path, uint256 amountIn)
        external
        returns (
            uint256 amountOut,
            uint160[] memory sqrtPriceX96AfterList,
            uint32[] memory initializedTicksCrossedList,
            uint256 gasEstimate
        );

    /// @notice Parameters for quoting a single-hop exact output swap.
    struct QuoteExactOutputSingleParams {
        address tokenIn;
        address tokenOut;
        uint256 amount;
        uint24 fee;
        uint160 sqrtPriceLimitX96;
    }

    /**
     * @notice Returns the amount in required for a given exact output swap without executing.
     * @param params The params for the quote.
     * @return amountIn The amount of `tokenIn` required.
     * @return sqrtPriceX96After The sqrt price after the swap.
     * @return initializedTicksCrossed The number of initialized ticks crossed.
     * @return gasEstimate The estimated gas for the swap.
     */
    function quoteExactOutputSingle(QuoteExactOutputSingleParams memory params)
        external
        returns (uint256 amountIn, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate);

    /**
     * @notice Returns the amount in required for a given exact output multi-hop swap.
     * @param path The encoded swap path (reversed: tokenOut, fee, tokenMid, fee, tokenIn).
     * @param amountOut The desired amount of the last token.
     * @return amountIn The amount of the first token required.
     * @return sqrtPriceX96AfterList The sqrt prices after each pool swap.
     * @return initializedTicksCrossedList The number of initialized ticks crossed for each pool.
     * @return gasEstimate The estimated gas for the entire swap.
     */
    function quoteExactOutput(bytes memory path, uint256 amountOut)
        external
        returns (
            uint256 amountIn,
            uint160[] memory sqrtPriceX96AfterList,
            uint32[] memory initializedTicksCrossedList,
            uint256 gasEstimate
        );
}