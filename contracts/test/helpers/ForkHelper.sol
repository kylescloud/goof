// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

/**
 * @title ForkHelper
 * @notice Manages vm.createFork(), vm.selectFork(), and block pinning for reproducible test environments.
 */
contract ForkHelper is Test {
    uint256 public baseForkId;
    bool public forkActive;

    /// @notice Base mainnet chain ID.
    uint256 public constant BASE_CHAIN_ID = 8453;

    /**
     * @notice Creates a fork of Base mainnet at the latest block.
     * @param rpcUrl The RPC URL for Base mainnet.
     * @return forkId The fork ID.
     */
    function createBaseFork(string memory rpcUrl) internal returns (uint256 forkId) {
        forkId = vm.createFork(rpcUrl);
        baseForkId = forkId;
        vm.selectFork(forkId);
        forkActive = true;
    }

    /**
     * @notice Creates a fork of Base mainnet at a specific block number.
     * @param rpcUrl The RPC URL for Base mainnet.
     * @param blockNumber The block number to fork at.
     * @return forkId The fork ID.
     */
    function createBaseForkAtBlock(string memory rpcUrl, uint256 blockNumber) internal returns (uint256 forkId) {
        forkId = vm.createFork(rpcUrl, blockNumber);
        baseForkId = forkId;
        vm.selectFork(forkId);
        forkActive = true;
    }

    /**
     * @notice Selects the Base mainnet fork.
     */
    function selectBaseFork() internal {
        require(forkActive, "Fork not created");
        vm.selectFork(baseForkId);
    }

    /**
     * @notice Rolls the fork to a specific block number.
     * @param blockNumber The target block number.
     */
    function rollForkTo(uint256 blockNumber) internal {
        require(forkActive, "Fork not created");
        vm.rollFork(blockNumber);
    }

    /**
     * @notice Gets the RPC URL from environment, with a fallback.
     * @return The RPC URL string.
     */
    function getBaseRpcUrl() internal view returns (string memory) {
        try vm.envString("RPC_URL_PRIMARY") returns (string memory url) {
            return url;
        } catch {
            return "https://mainnet.base.org";
        }
    }
}