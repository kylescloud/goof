// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title PathEncoder
 * @notice Encodes and decodes the packed-bytes path format used by Uniswap V3's multi-hop exactInput router calls.
 * @dev Path format: [tokenIn (20 bytes)][fee (3 bytes)][tokenMid (20 bytes)][fee (3 bytes)][tokenOut (20 bytes)]...
 *      Each hop is 23 bytes (20 address + 3 fee). A single-hop path is 43 bytes. Each additional hop adds 23 bytes.
 */
library PathEncoder {
    /// @dev The length of the bytes encoded address
    uint256 private constant ADDR_SIZE = 20;
    /// @dev The length of the bytes encoded fee
    uint256 private constant FEE_SIZE = 3;
    /// @dev The offset of a single token address and fee (next hop)
    uint256 private constant NEXT_OFFSET = ADDR_SIZE + FEE_SIZE;
    /// @dev The offset of an encoded pool key (tokenIn + fee + tokenOut)
    uint256 private constant POP_OFFSET = NEXT_OFFSET + ADDR_SIZE;
    /// @dev The minimum length of an encoding that contains 2 or more pools
    uint256 private constant MULTIPLE_POOLS_MIN_LENGTH = POP_OFFSET + NEXT_OFFSET;

    /**
     * @notice Encodes a single-hop V3 path.
     * @param tokenIn The input token address.
     * @param fee The fee tier.
     * @param tokenOut The output token address.
     * @return path The encoded path bytes.
     */
    function encodeSingleHop(address tokenIn, uint24 fee, address tokenOut) internal pure returns (bytes memory path) {
        path = abi.encodePacked(tokenIn, fee, tokenOut);
    }

    /**
     * @notice Encodes a two-hop V3 path.
     * @param tokenIn The input token address.
     * @param fee1 The fee tier for the first hop.
     * @param tokenMid The intermediate token address.
     * @param fee2 The fee tier for the second hop.
     * @param tokenOut The output token address.
     * @return path The encoded path bytes.
     */
    function encodeTwoHop(
        address tokenIn,
        uint24 fee1,
        address tokenMid,
        uint24 fee2,
        address tokenOut
    ) internal pure returns (bytes memory path) {
        path = abi.encodePacked(tokenIn, fee1, tokenMid, fee2, tokenOut);
    }

    /**
     * @notice Encodes a multi-hop V3 path from arrays of tokens and fees.
     * @param tokens Array of token addresses (length = n).
     * @param fees Array of fee tiers (length = n - 1).
     * @return path The encoded path bytes.
     */
    function encodeMultiHop(address[] memory tokens, uint24[] memory fees) internal pure returns (bytes memory path) {
        require(tokens.length >= 2, "PathEncoder: need at least 2 tokens");
        require(fees.length == tokens.length - 1, "PathEncoder: fees length mismatch");

        path = abi.encodePacked(tokens[0]);
        for (uint256 i = 0; i < fees.length; i++) {
            path = abi.encodePacked(path, fees[i], tokens[i + 1]);
        }
    }

    /**
     * @notice Returns true if the path contains two or more pools.
     * @param path The encoded swap path.
     * @return True if the path has multiple pools.
     */
    function hasMultiplePools(bytes memory path) internal pure returns (bool) {
        return path.length >= MULTIPLE_POOLS_MIN_LENGTH;
    }

    /**
     * @notice Returns the number of pools in the path.
     * @param path The encoded swap path.
     * @return The number of pools.
     */
    function numPools(bytes memory path) internal pure returns (uint256) {
        return ((path.length - ADDR_SIZE) / NEXT_OFFSET);
    }

    /**
     * @notice Decodes the first pool in the path.
     * @param path The encoded swap path.
     * @return tokenA The first token address.
     * @return tokenB The second token address.
     * @return fee The fee tier.
     */
    function decodeFirstPool(bytes memory path)
        internal
        pure
        returns (address tokenA, address tokenB, uint24 fee)
    {
        require(path.length >= POP_OFFSET, "PathEncoder: path too short");
        assembly {
            let firstWord := mload(add(path, 0x20))
            tokenA := shr(96, firstWord)
            fee := and(shr(72, firstWord), 0xffffff)
            tokenB := shr(96, mload(add(path, 0x37)))
        }
    }

    /**
     * @notice Skips a token + fee element from the buffer and returns the remainder.
     * @param path The original encoded swap path.
     * @return The remaining path after skipping the first token + fee.
     */
    function skipToken(bytes memory path) internal pure returns (bytes memory) {
        require(path.length >= NEXT_OFFSET, "PathEncoder: path too short to skip");
        uint256 newLength = path.length - NEXT_OFFSET;
        bytes memory remainingPath = new bytes(newLength);
        assembly {
            let src := add(add(path, 0x20), NEXT_OFFSET)
            let dst := add(remainingPath, 0x20)
            for { let i := 0 } lt(i, newLength) { i := add(i, 0x20) } {
                mstore(add(dst, i), mload(add(src, i)))
            }
        }
        return remainingPath;
    }

    /**
     * @notice Extracts the first token from the path.
     * @param path The encoded swap path.
     * @return token The first token address.
     */
    function getFirstToken(bytes memory path) internal pure returns (address token) {
        require(path.length >= ADDR_SIZE, "PathEncoder: path too short");
        assembly {
            token := shr(96, mload(add(path, 0x20)))
        }
    }

    /**
     * @notice Extracts the last token from the path.
     * @param path The encoded swap path.
     * @return token The last token address.
     */
    function getLastToken(bytes memory path) internal pure returns (address token) {
        require(path.length >= ADDR_SIZE, "PathEncoder: path too short");
        assembly {
            token := shr(96, mload(add(add(path, 0x20), sub(mload(path), ADDR_SIZE))))
        }
    }
}