// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IUniswapV2Router02
 * @notice Standard Uniswap V2 Router02 interface for token swaps and liquidity operations.
 */
interface IUniswapV2Router02 {
    /// @notice Returns the factory address.
    function factory() external pure returns (address);

    /// @notice Returns the WETH address.
    function WETH() external pure returns (address);

    /**
     * @notice Swaps an exact amount of input tokens for as many output tokens as possible.
     * @param amountIn The amount of input tokens to send.
     * @param amountOutMin The minimum amount of output tokens to receive.
     * @param path An array of token addresses representing the swap route.
     * @param to The recipient of the output tokens.
     * @param deadline Unix timestamp after which the transaction will revert.
     * @return amounts The input and output amounts for each step of the swap.
     */
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);

    /**
     * @notice Given an input amount and an array of token addresses, calculates all subsequent
     *         maximum output token amounts.
     * @param amountIn The input amount.
     * @param path The swap path.
     * @return amounts The amounts for each step.
     */
    function getAmountsOut(uint256 amountIn, address[] calldata path)
        external
        view
        returns (uint256[] memory amounts);

    /**
     * @notice Given an output amount and an array of token addresses, calculates all preceding
     *         minimum input token amounts.
     * @param amountOut The desired output amount.
     * @param path The swap path.
     * @return amounts The amounts for each step.
     */
    function getAmountsIn(uint256 amountOut, address[] calldata path)
        external
        view
        returns (uint256[] memory amounts);

    /**
     * @notice Given an input amount of an asset and pair reserves, returns the maximum output
     *         amount of the other asset.
     * @param amountIn The input amount.
     * @param reserveIn The reserve of the input token.
     * @param reserveOut The reserve of the output token.
     * @return amountOut The output amount.
     */
    function getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut)
        external
        pure
        returns (uint256 amountOut);

    /**
     * @notice Given an output amount of an asset and pair reserves, returns the required input
     *         amount of the other asset.
     * @param amountOut The desired output amount.
     * @param reserveIn The reserve of the input token.
     * @param reserveOut The reserve of the output token.
     * @return amountIn The required input amount.
     */
    function getAmountIn(uint256 amountOut, uint256 reserveIn, uint256 reserveOut)
        external
        pure
        returns (uint256 amountIn);
}