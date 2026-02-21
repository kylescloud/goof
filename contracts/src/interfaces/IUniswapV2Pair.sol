// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IUniswapV2Pair
 * @notice Standard Uniswap V2 pair interface for reserve reads and low-level swaps.
 */
interface IUniswapV2Pair {
    /// @notice Emitted on each swap.
    event Swap(
        address indexed sender,
        uint256 amount0In,
        uint256 amount1In,
        uint256 amount0Out,
        uint256 amount1Out,
        address indexed to
    );

    /// @notice Emitted on sync (reserve update).
    event Sync(uint112 reserve0, uint112 reserve1);

    /// @notice Returns the address of token0.
    function token0() external view returns (address);

    /// @notice Returns the address of token1.
    function token1() external view returns (address);

    /// @notice Returns the current reserves and the last block timestamp.
    /// @return reserve0 The reserve of token0.
    /// @return reserve1 The reserve of token1.
    /// @return blockTimestampLast The timestamp of the last reserve update.
    function getReserves()
        external
        view
        returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);

    /// @notice Executes a low-level swap.
    /// @param amount0Out The amount of token0 to send to `to`.
    /// @param amount1Out The amount of token1 to send to `to`.
    /// @param to The recipient address.
    /// @param data If non-empty, triggers a flash swap callback.
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;

    /// @notice Returns the factory address that created this pair.
    function factory() external view returns (address);

    /// @notice Forces reserves to match balances.
    function sync() external;
}

/**
 * @title IUniswapV2Factory
 * @notice Standard Uniswap V2 factory interface for pair enumeration.
 */
interface IUniswapV2Factory {
    /// @notice Emitted when a new pair is created.
    event PairCreated(address indexed token0, address indexed token1, address pair, uint256);

    /// @notice Returns the pair address for two tokens, or address(0) if none exists.
    function getPair(address tokenA, address tokenB) external view returns (address pair);

    /// @notice Returns the pair address at the given index.
    function allPairs(uint256 index) external view returns (address pair);

    /// @notice Returns the total number of pairs created.
    function allPairsLength() external view returns (uint256);

    /// @notice Returns the fee recipient address.
    function feeTo() external view returns (address);
}