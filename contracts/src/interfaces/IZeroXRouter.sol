// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IZeroXRouter
 * @notice Interface for forwarding pre-encoded 0x Protocol calldata through the smart contract.
 *         Supports both permit2 and legacy ERC20 approval paths.
 */
interface IZeroXRouter {
    /**
     * @notice Executes a 0x swap by forwarding pre-encoded calldata to the 0x exchange proxy.
     * @param tokenIn The input token address.
     * @param tokenOut The output token address.
     * @param amountIn The amount of input tokens.
     * @param minAmountOut The minimum acceptable output amount.
     * @param exchangeProxy The address of the 0x exchange proxy to call.
     * @param allowanceTarget The address to approve for token spending (may differ from exchangeProxy for permit2).
     * @param swapCalldata The pre-encoded calldata from the 0x API quote response.
     * @return amountOut The actual amount of output tokens received.
     */
    function executeZeroXSwap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        address exchangeProxy,
        address allowanceTarget,
        bytes calldata swapCalldata
    ) external returns (uint256 amountOut);
}

/**
 * @title IERC20
 * @notice Minimal ERC20 interface used throughout the contract.
 */
interface IERC20 {
    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function decimals() external view returns (uint8);
    function symbol() external view returns (string memory);
    function name() external view returns (string memory);
}