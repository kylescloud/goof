// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IUniswapV3Router
 * @notice Interface for the Uniswap V3 SwapRouter for executing single-hop and multi-hop swaps.
 */
interface IUniswapV3Router {
    /// @notice Parameters for a single-hop exact input swap.
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    /// @notice Parameters for a multi-hop exact input swap.
    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    /// @notice Parameters for a single-hop exact output swap.
    struct ExactOutputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountOut;
        uint256 amountInMaximum;
        uint160 sqrtPriceLimitX96;
    }

    /// @notice Parameters for a multi-hop exact output swap.
    struct ExactOutputParams {
        bytes path;
        address recipient;
        uint256 deadline;
        uint256 amountOut;
        uint256 amountInMaximum;
    }

    /**
     * @notice Swaps `amountIn` of one token for as much as possible of another token (single hop).
     * @param params The parameters necessary for the swap.
     * @return amountOut The amount of the received token.
     */
    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);

    /**
     * @notice Swaps `amountIn` of one token for as much as possible of another along the specified path.
     * @param params The parameters necessary for the multi-hop swap.
     * @return amountOut The amount of the received token.
     */
    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);

    /**
     * @notice Swaps as little as possible of one token for `amountOut` of another token (single hop).
     * @param params The parameters necessary for the swap.
     * @return amountIn The amount of the input token.
     */
    function exactOutputSingle(ExactOutputSingleParams calldata params) external payable returns (uint256 amountIn);

    /**
     * @notice Swaps as little as possible of one token for `amountOut` of another along the specified path.
     * @param params The parameters necessary for the multi-hop swap.
     * @return amountIn The amount of the input token.
     */
    function exactOutput(ExactOutputParams calldata params) external payable returns (uint256 amountIn);
}