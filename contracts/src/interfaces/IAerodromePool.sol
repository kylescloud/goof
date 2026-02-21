// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IAerodromePool
 * @notice Interface for Aerodrome Finance classic AMM pools (both stable and volatile).
 */
interface IAerodromePool {
    /// @notice Returns the address of token0.
    function token0() external view returns (address);

    /// @notice Returns the address of token1.
    function token1() external view returns (address);

    /// @notice Returns whether this is a stable pool.
    function stable() external view returns (bool);

    /**
     * @notice Returns the current reserves and the last block timestamp.
     * @return _reserve0 The reserve of token0.
     * @return _reserve1 The reserve of token1.
     * @return _blockTimestampLast The timestamp of the last reserve update.
     */
    function getReserves()
        external
        view
        returns (uint256 _reserve0, uint256 _reserve1, uint256 _blockTimestampLast);

    /**
     * @notice Returns the expected output amount for a given input.
     * @param amountIn The input amount.
     * @param tokenIn The input token address.
     * @return amountOut The expected output amount.
     */
    function getAmountOut(uint256 amountIn, address tokenIn) external view returns (uint256 amountOut);

    /// @notice Returns the factory address that created this pool.
    function factory() external view returns (address);

    /// @notice Returns the pool metadata.
    /// @return dec0 Decimals of token0.
    /// @return dec1 Decimals of token1.
    /// @return r0 Reserve of token0.
    /// @return r1 Reserve of token1.
    /// @return st Whether the pool is stable.
    /// @return t0 Address of token0.
    /// @return t1 Address of token1.
    function metadata()
        external
        view
        returns (uint256 dec0, uint256 dec1, uint256 r0, uint256 r1, bool st, address t0, address t1);

    /**
     * @notice Executes a low-level swap.
     * @param amount0Out The amount of token0 to send.
     * @param amount1Out The amount of token1 to send.
     * @param to The recipient address.
     * @param data Callback data.
     */
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}