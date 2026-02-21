// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IAaveV3Pool
 * @notice Minimal interface for the Aave V3 Pool contract on Base.
 *         Exposes flash loan, reserve list, and reserve data functions.
 */
interface IAaveV3Pool {
    /// @notice Struct representing the reserve configuration data.
    struct ReserveConfigurationMap {
        uint256 data;
    }

    /// @notice Struct representing the full reserve data for an asset.
    struct ReserveData {
        ReserveConfigurationMap configuration;
        uint128 liquidityIndex;
        uint128 currentLiquidityRate;
        uint128 variableBorrowIndex;
        uint128 currentVariableBorrowRate;
        uint128 currentStableBorrowRate;
        uint40 lastUpdateTimestamp;
        uint16 id;
        address aTokenAddress;
        address stableDebtTokenAddress;
        address variableDebtTokenAddress;
        address interestRateStrategyAddress;
        uint128 accruedToTreasury;
        uint128 unbacked;
        uint128 isolationModeTotalDebt;
    }

    /**
     * @notice Executes a simple flash loan (single asset).
     * @param receiverAddress The address of the contract receiving the flash loan.
     * @param asset The address of the asset to flash borrow.
     * @param amount The amount to flash borrow.
     * @param params Arbitrary bytes passed to the receiver's executeOperation callback.
     * @param referralCode Referral code for Aave (use 0).
     */
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;

    /**
     * @notice Returns the list of all reserve asset addresses.
     * @return An array of reserve asset addresses.
     */
    function getReservesList() external view returns (address[] memory);

    /**
     * @notice Returns the reserve data for a given asset.
     * @param asset The address of the reserve asset.
     * @return The ReserveData struct for the asset.
     */
    function getReserveData(address asset) external view returns (ReserveData memory);

    /**
     * @notice Returns the total flash loan premium as a percentage (in bps).
     * @return The flash loan premium total in basis points.
     */
    function FLASHLOAN_PREMIUM_TOTAL() external view returns (uint128);

    /**
     * @notice Returns the addresses provider used by this pool.
     * @return The addresses provider address.
     */
    function ADDRESSES_PROVIDER() external view returns (address);
}

/**
 * @title IFlashLoanSimpleReceiver
 * @notice Interface that must be implemented by contracts receiving Aave V3 simple flash loans.
 */
interface IFlashLoanSimpleReceiver {
    /**
     * @notice Called by the Aave V3 Pool after the flash loan funds have been transferred.
     * @param asset The address of the flash-borrowed asset.
     * @param amount The amount of the flash-borrowed asset.
     * @param premium The fee to be paid on top of the borrowed amount.
     * @param initiator The address that initiated the flash loan.
     * @param params The encoded parameters passed from the initiator.
     * @return True if the operation was successful and the loan + premium can be repaid.
     */
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool);
}

/**
 * @title IPoolAddressesProvider
 * @notice Minimal interface for the Aave V3 PoolAddressesProvider.
 */
interface IPoolAddressesProvider {
    /**
     * @notice Returns the address of the Pool proxy.
     * @return The Pool proxy address.
     */
    function getPool() external view returns (address);

    /**
     * @notice Returns the address of the PriceOracle.
     * @return The PriceOracle address.
     */
    function getPriceOracle() external view returns (address);
}