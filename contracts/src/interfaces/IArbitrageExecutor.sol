// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IArbitrageExecutor
 * @notice Interface for the ArbitrageExecutor contract used by the off-chain bot
 *         to ABI-encode calldata for flash loan arbitrage execution.
 */
interface IArbitrageExecutor {
    /// @notice Represents a single swap step within an arbitrage path.
    struct SwapStep {
        /// @dev Numeric DEX identifier (see DexId enum in constants).
        uint8 dexId;
        /// @dev Address of the input token for this swap step.
        address tokenIn;
        /// @dev Address of the output token for this swap step.
        address tokenOut;
        /// @dev Address of the liquidity pool to use for this swap.
        address pool;
        /// @dev Fee tier in basis points (used for V3 pools; 0 for V2).
        uint24 fee;
        /// @dev Minimum acceptable output amount for this step (slippage protection).
        uint256 minAmountOut;
        /// @dev Arbitrary extra data for DEX-specific routing (e.g., 0x calldata, Aerodrome route encoding).
        bytes extraData;
    }

    /// @notice Parameters for initiating a flash loan arbitrage.
    struct FlashLoanParams {
        /// @dev Address of the asset to flash borrow from Aave V3.
        address flashAsset;
        /// @dev Amount of the flash asset to borrow.
        uint256 flashAmount;
        /// @dev Ordered array of swap steps constituting the arbitrage path.
        SwapStep[] steps;
        /// @dev Minimum total return amount after all swaps (must cover loan + premium + minProfit).
        uint256 minReturnAmount;
        /// @dev Unix timestamp deadline; transaction reverts if block.timestamp exceeds this.
        uint256 deadline;
    }

    /// @notice Emitted when an arbitrage is executed successfully.
    /// @param executor The address that initiated the arbitrage.
    /// @param flashAsset The asset that was flash borrowed.
    /// @param flashAmount The amount that was flash borrowed.
    /// @param profit The net profit after repaying the flash loan.
    /// @param gasUsed The gas consumed by the transaction.
    event ArbitrageExecuted(
        address indexed executor,
        address indexed flashAsset,
        uint256 flashAmount,
        uint256 profit,
        uint256 gasUsed
    );

    /// @notice Emitted when an arbitrage simulation is run (off-chain via eth_call).
    /// @param flashAsset The asset simulated for flash borrowing.
    /// @param flashAmount The simulated borrow amount.
    /// @param expectedProfit The expected profit from the simulation.
    /// @param isProfitable Whether the simulation determined the path is profitable.
    event ArbitrageSimulated(
        address indexed flashAsset,
        uint256 flashAmount,
        uint256 expectedProfit,
        bool isProfitable
    );

    /// @notice Emitted when the authorized executor address is updated.
    /// @param oldExecutor The previous executor address.
    /// @param newExecutor The new executor address.
    event ExecutorUpdated(address indexed oldExecutor, address indexed newExecutor);

    /// @notice Emitted when the minimum profit threshold is updated.
    /// @param oldMinProfit The previous minimum profit.
    /// @param newMinProfit The new minimum profit.
    event MinProfitUpdated(uint256 oldMinProfit, uint256 newMinProfit);

    /// @notice Emitted when tokens are rescued from the contract.
    /// @param token The token address rescued.
    /// @param amount The amount rescued.
    /// @param to The recipient address.
    event TokensRescued(address indexed token, uint256 amount, address indexed to);

    /// @notice Initiates a flash loan arbitrage.
    /// @param params The flash loan and swap parameters.
    function executeArbitrage(FlashLoanParams calldata params) external;

    /// @notice Simulates an arbitrage path without executing (view function for eth_call).
    /// @param params The flash loan and swap parameters to simulate.
    /// @return expectedProfit The expected profit in flash asset units.
    /// @return isProfitable Whether the path is profitable after all costs.
    function simulateArbitrage(FlashLoanParams calldata params)
        external
        view
        returns (uint256 expectedProfit, bool isProfitable);

    /// @notice Rescues tokens accidentally sent to the contract.
    /// @param token The ERC20 token address to rescue.
    /// @param amount The amount to rescue.
    function rescueTokens(address token, uint256 amount) external;

    /// @notice Updates the authorized executor address.
    /// @param newExecutor The new executor address.
    function updateAuthorizedExecutor(address newExecutor) external;

    /// @notice Updates the minimum profit threshold enforced on-chain.
    /// @param newMinProfit The new minimum profit in flash asset units.
    function updateMinProfit(uint256 newMinProfit) external;

    /// @notice Returns the current authorized executor address.
    /// @return The executor address.
    function authorizedExecutor() external view returns (address);

    /// @notice Returns the current minimum profit threshold.
    /// @return The minimum profit in flash asset units.
    function minProfit() external view returns (uint256);
}