// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IArbitrageExecutor} from "./interfaces/IArbitrageExecutor.sol";
import {IAaveV3Pool, IFlashLoanSimpleReceiver} from "./interfaces/IAaveV3Pool.sol";
import {IUniswapV2Pair} from "./interfaces/IUniswapV2Pair.sol";
import {IUniswapV2Router02} from "./interfaces/IUniswapV2Router02.sol";
import {IUniswapV3Router} from "./interfaces/IUniswapV3Router.sol";
import {IAerodromeRouter} from "./interfaces/IAerodromeRouter.sol";
import {IAerodromePool} from "./interfaces/IAerodromePool.sol";
import {IAerodromeCLPool, IAerodromeCLRouter} from "./interfaces/IAerodromeCLPool.sol";
import {IERC20} from "./interfaces/IZeroXRouter.sol";

/**
 * @title ArbitrageExecutor
 * @author Base Arbitrage Bot
 * @notice Executes multi-strategy flash loan arbitrage on Base via Aave V3.
 * @dev Implements IFlashLoanSimpleReceiver for Aave V3 callback. Uses ReentrancyGuard
 *      pattern, authorized-caller whitelist, and on-chain deadline enforcement.
 *      Supports V2 AMM, V3 CLMM, Aerodrome classic, Aerodrome Slipstream, and 0x swaps.
 *
 *      DEX ID Mapping:
 *        0 = Uniswap V2
 *        1 = Uniswap V3
 *        2 = SushiSwap V2
 *        3 = SushiSwap V3
 *        4 = Aerodrome (classic)
 *        5 = Aerodrome Slipstream (CL)
 *        6 = BaseSwap V2
 *        7 = BaseSwap V3
 *        8 = SwapBased
 *        9 = PancakeSwap V3
 *       10 = 0x Aggregator
 */
contract ArbitrageExecutor is IFlashLoanSimpleReceiver {
    // ─── State Variables ────────────────────────────────────────────────

    /// @notice The Aave V3 Pool contract address.
    address public immutable AAVE_POOL;

    /// @notice The contract owner.
    address public owner;

    /// @notice The authorized executor EOA address.
    address public authorizedExecutor;

    /// @notice Minimum profit enforced on-chain (in flash asset units).
    uint256 public minProfit;

    /// @notice Reentrancy lock state.
    uint256 private _locked;

    /// @dev Constant for reentrancy guard unlocked state.
    uint256 private constant _NOT_ENTERED = 1;
    /// @dev Constant for reentrancy guard locked state.
    uint256 private constant _ENTERED = 2;

    // ─── DEX Router Addresses ───────────────────────────────────────────

    /// @notice Mapping of dexId => router address for V2-style DEXes.
    mapping(uint8 => address) public v2Routers;

    /// @notice Mapping of dexId => router address for V3-style DEXes.
    mapping(uint8 => address) public v3Routers;

    // ─── Events ─────────────────────────────────────────────────────────

    event ArbitrageExecuted(
        address indexed executor,
        address indexed flashAsset,
        uint256 flashAmount,
        uint256 profit,
        uint256 gasUsed
    );

    event ArbitrageSimulated(
        address indexed flashAsset,
        uint256 flashAmount,
        uint256 expectedProfit,
        bool isProfitable
    );

    event ExecutorUpdated(address indexed oldExecutor, address indexed newExecutor);
    event MinProfitUpdated(uint256 oldMinProfit, uint256 newMinProfit);
    event TokensRescued(address indexed token, uint256 amount, address indexed to);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event RouterUpdated(uint8 indexed dexId, bool isV3, address router);

    // ─── Errors ─────────────────────────────────────────────────────────

    error Unauthorized();
    error DeadlineExpired();
    error InsufficientProfit(uint256 received, uint256 required);
    error InvalidFlashLoanCallback();
    error SwapFailed(uint8 dexId, uint256 stepIndex);
    error ZeroAddress();
    error ReentrancyGuardReentrantCall();
    error InvalidDexId(uint8 dexId);
    error MinAmountNotMet(uint256 received, uint256 minimum);

    // ─── Modifiers ──────────────────────────────────────────────────────

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    modifier onlyAuthorized() {
        if (msg.sender != authorizedExecutor && msg.sender != owner) revert Unauthorized();
        _;
    }

    modifier nonReentrant() {
        if (_locked == _ENTERED) revert ReentrancyGuardReentrantCall();
        _locked = _ENTERED;
        _;
        _locked = _NOT_ENTERED;
    }

    modifier checkDeadline(uint256 deadline) {
        if (block.timestamp > deadline) revert DeadlineExpired();
        _;
    }

    // ─── Constructor ────────────────────────────────────────────────────

    /**
     * @notice Deploys the ArbitrageExecutor contract.
     * @param _aavePool The Aave V3 Pool address on Base.
     * @param _executor The initial authorized executor EOA.
     * @param _minProfit The initial minimum profit threshold.
     * @param _v2RouterIds Array of V2 DEX IDs.
     * @param _v2RouterAddrs Array of V2 router addresses (same order as IDs).
     * @param _v3RouterIds Array of V3 DEX IDs.
     * @param _v3RouterAddrs Array of V3 router addresses (same order as IDs).
     */
    constructor(
        address _aavePool,
        address _executor,
        uint256 _minProfit,
        uint8[] memory _v2RouterIds,
        address[] memory _v2RouterAddrs,
        uint8[] memory _v3RouterIds,
        address[] memory _v3RouterAddrs
    ) {
        if (_aavePool == address(0) || _executor == address(0)) revert ZeroAddress();
        require(_v2RouterIds.length == _v2RouterAddrs.length, "V2 router length mismatch");
        require(_v3RouterIds.length == _v3RouterAddrs.length, "V3 router length mismatch");

        AAVE_POOL = _aavePool;
        owner = msg.sender;
        authorizedExecutor = _executor;
        minProfit = _minProfit;
        _locked = _NOT_ENTERED;

        for (uint256 i = 0; i < _v2RouterIds.length; i++) {
            v2Routers[_v2RouterIds[i]] = _v2RouterAddrs[i];
            emit RouterUpdated(_v2RouterIds[i], false, _v2RouterAddrs[i]);
        }

        for (uint256 i = 0; i < _v3RouterIds.length; i++) {
            v3Routers[_v3RouterIds[i]] = _v3RouterAddrs[i];
            emit RouterUpdated(_v3RouterIds[i], true, _v3RouterAddrs[i]);
        }

        emit OwnershipTransferred(address(0), msg.sender);
        emit ExecutorUpdated(address(0), _executor);
    }

    // ─── Core Execution ─────────────────────────────────────────────────

    /**
     * @notice Initiates a flash loan arbitrage.
     * @dev Only callable by the authorized executor or owner. Triggers Aave V3 flashLoanSimple.
     * @param params The flash loan and swap parameters.
     */
    function executeArbitrage(IArbitrageExecutor.FlashLoanParams calldata params)
        external
        onlyAuthorized
        nonReentrant
        checkDeadline(params.deadline)
    {
        uint256 gasStart = gasleft();

        bytes memory encodedParams = abi.encode(params.steps, params.minReturnAmount, params.deadline, gasStart);

        IAaveV3Pool(AAVE_POOL).flashLoanSimple(
            address(this),
            params.flashAsset,
            params.flashAmount,
            encodedParams,
            0 // referralCode
        );
    }

    /**
     * @notice Aave V3 flash loan callback. Executes the arbitrage swap path.
     * @dev Called by the Aave V3 Pool after flash loan funds are transferred.
     * @param asset The flash-borrowed asset address.
     * @param amount The flash-borrowed amount.
     * @param premium The fee to repay on top of the borrowed amount.
     * @param initiator The address that initiated the flash loan (must be this contract).
     * @param params The encoded swap parameters.
     * @return True if the operation succeeded.
     */
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external override returns (bool) {
        // Validate callback origin
        if (msg.sender != AAVE_POOL) revert InvalidFlashLoanCallback();
        if (initiator != address(this)) revert InvalidFlashLoanCallback();

        // Decode parameters
        (
            IArbitrageExecutor.SwapStep[] memory steps,
            uint256 minReturnAmount,
            uint256 deadline,
            uint256 gasStart
        ) = abi.decode(params, (IArbitrageExecutor.SwapStep[], uint256, uint256, uint256));

        // Check deadline
        if (block.timestamp > deadline) revert DeadlineExpired();

        // Execute each swap step
        uint256 currentAmount = amount;
        for (uint256 i = 0; i < steps.length; i++) {
            currentAmount = _executeSwapStep(steps[i], currentAmount, i);
        }

        // Calculate repayment and profit
        uint256 totalOwed = amount + premium;
        if (currentAmount < totalOwed + minProfit) {
            revert InsufficientProfit(currentAmount, totalOwed + minProfit);
        }
        if (currentAmount < minReturnAmount) {
            revert InsufficientProfit(currentAmount, minReturnAmount);
        }

        uint256 profit = currentAmount - totalOwed;

        // Approve Aave Pool for repayment
        _safeApprove(asset, AAVE_POOL, totalOwed);

        // Transfer profit to the authorized executor
        if (profit > 0) {
            _safeTransfer(asset, authorizedExecutor, profit);
        }

        uint256 gasUsed = gasStart - gasleft();
        emit ArbitrageExecuted(authorizedExecutor, asset, amount, profit, gasUsed);

        return true;
    }

    // ─── Simulation ─────────────────────────────────────────────────────

    /**
     * @notice Simulates an arbitrage path without executing (view function for eth_call).
     * @dev Uses staticcall internally to simulate swap outputs. Not a true view function
     *      because DEX quoters may modify state, but intended to be called via eth_call.
     * @param params The flash loan and swap parameters to simulate.
     * @return expectedProfit The expected profit in flash asset units.
     * @return isProfitable Whether the path is profitable after all costs.
     */
    function simulateArbitrage(IArbitrageExecutor.FlashLoanParams calldata params)
        external
        view
        returns (uint256 expectedProfit, bool isProfitable)
    {
        uint256 currentAmount = params.flashAmount;

        // Simulate each swap step using on-chain math
        for (uint256 i = 0; i < params.steps.length; i++) {
            IArbitrageExecutor.SwapStep calldata step = params.steps[i];
            uint256 amountOut = _simulateSwapStep(step, currentAmount);
            if (amountOut == 0) {
                return (0, false);
            }
            currentAmount = amountOut;
        }

        // Calculate flash loan premium (5 bps = 0.05%)
        uint256 premium = (params.flashAmount * 5) / 10000;
        uint256 totalOwed = params.flashAmount + premium;

        if (currentAmount > totalOwed + minProfit) {
            expectedProfit = currentAmount - totalOwed;
            isProfitable = true;
        } else {
            expectedProfit = 0;
            isProfitable = false;
        }
    }

    // ─── Internal Swap Routing ──────────────────────────────────────────

    /**
     * @notice Routes a single swap step to the correct DEX handler.
     * @param step The swap step parameters.
     * @param amountIn The input amount for this step.
     * @param stepIndex The index of this step (for error reporting).
     * @return amountOut The actual output amount received.
     */
    function _executeSwapStep(
        IArbitrageExecutor.SwapStep memory step,
        uint256 amountIn,
        uint256 stepIndex
    ) internal returns (uint256 amountOut) {
        if (step.dexId <= 2 || step.dexId == 6 || step.dexId == 8) {
            // V2-style DEXes: Uniswap V2 (0), SushiSwap V2 (2), BaseSwap V2 (6), SwapBased (8)
            amountOut = _executeV2Swap(step, amountIn);
        } else if (step.dexId == 1 || step.dexId == 3 || step.dexId == 7 || step.dexId == 9) {
            // V3-style DEXes: Uniswap V3 (1), SushiSwap V3 (3), BaseSwap V3 (7), PancakeSwap V3 (9)
            amountOut = _executeV3Swap(step, amountIn);
        } else if (step.dexId == 4) {
            // Aerodrome classic
            amountOut = _executeAerodromeSwap(step, amountIn);
        } else if (step.dexId == 5) {
            // Aerodrome Slipstream (CL)
            amountOut = _executeAerodromeSlipstreamSwap(step, amountIn);
        } else if (step.dexId == 10) {
            // 0x Aggregator
            amountOut = _executeZeroXSwap(step, amountIn);
        } else {
            revert InvalidDexId(step.dexId);
        }

        if (amountOut < step.minAmountOut) {
            revert MinAmountNotMet(amountOut, step.minAmountOut);
        }
        if (amountOut == 0) {
            revert SwapFailed(step.dexId, stepIndex);
        }
    }

    /**
     * @notice Executes a V2-style AMM swap via the pool's low-level swap function.
     * @param step The swap step parameters.
     * @param amountIn The input amount.
     * @return amountOut The output amount received.
     */
    function _executeV2Swap(
        IArbitrageExecutor.SwapStep memory step,
        uint256 amountIn
    ) internal returns (uint256 amountOut) {
        IUniswapV2Pair pair = IUniswapV2Pair(step.pool);

        // Get reserves
        (uint112 reserve0, uint112 reserve1,) = pair.getReserves();
        address token0 = pair.token0();

        // Determine direction and calculate output
        bool isToken0In = step.tokenIn == token0;
        uint256 reserveIn = isToken0In ? uint256(reserve0) : uint256(reserve1);
        uint256 reserveOut = isToken0In ? uint256(reserve1) : uint256(reserve0);

        // Standard V2 AMM formula with 0.3% fee (997/1000)
        uint256 amountInWithFee = amountIn * 997;
        amountOut = (amountInWithFee * reserveOut) / (reserveIn * 1000 + amountInWithFee);

        // Transfer tokens to the pair
        _safeTransfer(step.tokenIn, step.pool, amountIn);

        // Execute the swap
        uint256 amount0Out = isToken0In ? uint256(0) : amountOut;
        uint256 amount1Out = isToken0In ? amountOut : uint256(0);
        pair.swap(amount0Out, amount1Out, address(this), new bytes(0));
    }

    /**
     * @notice Executes a V3-style CLMM swap via the router.
     * @param step The swap step parameters.
     * @param amountIn The input amount.
     * @return amountOut The output amount received.
     */
    function _executeV3Swap(
        IArbitrageExecutor.SwapStep memory step,
        uint256 amountIn
    ) internal returns (uint256 amountOut) {
        address router = v3Routers[step.dexId];
        require(router != address(0), "V3 router not set");

        // Approve router
        _safeApprove(step.tokenIn, router, amountIn);

        // Execute exactInputSingle
        IUniswapV3Router.ExactInputSingleParams memory params = IUniswapV3Router.ExactInputSingleParams({
            tokenIn: step.tokenIn,
            tokenOut: step.tokenOut,
            fee: step.fee,
            recipient: address(this),
            deadline: block.timestamp,
            amountIn: amountIn,
            amountOutMinimum: step.minAmountOut,
            sqrtPriceLimitX96: 0
        });

        amountOut = IUniswapV3Router(router).exactInputSingle(params);
    }

    /**
     * @notice Executes an Aerodrome classic pool swap.
     * @param step The swap step parameters.
     * @param amountIn The input amount.
     * @return amountOut The output amount received.
     */
    function _executeAerodromeSwap(
        IArbitrageExecutor.SwapStep memory step,
        uint256 amountIn
    ) internal returns (uint256 amountOut) {
        // Decode extraData to get: router address, stable flag, factory address
        (address router, bool stable, address factory) = abi.decode(step.extraData, (address, bool, address));

        // Approve router
        _safeApprove(step.tokenIn, router, amountIn);

        // Build route
        IAerodromeRouter.Route[] memory routes = new IAerodromeRouter.Route[](1);
        routes[0] = IAerodromeRouter.Route({
            from: step.tokenIn,
            to: step.tokenOut,
            stable: stable,
            factory: factory
        });

        // Execute swap
        uint256[] memory amounts = IAerodromeRouter(router).swapExactTokensForTokens(
            amountIn,
            step.minAmountOut,
            routes,
            address(this),
            block.timestamp
        );

        amountOut = amounts[amounts.length - 1];
    }

    /**
     * @notice Executes an Aerodrome Slipstream (CL) swap via the CL router.
     * @param step The swap step parameters.
     * @param amountIn The input amount.
     * @return amountOut The output amount received.
     */
    function _executeAerodromeSlipstreamSwap(
        IArbitrageExecutor.SwapStep memory step,
        uint256 amountIn
    ) internal returns (uint256 amountOut) {
        // Decode extraData to get: router address, tickSpacing
        (address router, int24 tickSpacing) = abi.decode(step.extraData, (address, int24));

        // Approve router
        _safeApprove(step.tokenIn, router, amountIn);

        // Execute exactInputSingle on Slipstream
        IAerodromeCLRouter.ExactInputSingleParams memory params = IAerodromeCLRouter.ExactInputSingleParams({
            tokenIn: step.tokenIn,
            tokenOut: step.tokenOut,
            tickSpacing: tickSpacing,
            recipient: address(this),
            deadline: block.timestamp,
            amountIn: amountIn,
            amountOutMinimum: step.minAmountOut,
            sqrtPriceLimitX96: 0
        });

        amountOut = IAerodromeCLRouter(router).exactInputSingle(params);
    }

    /**
     * @notice Executes a 0x aggregator swap by forwarding pre-encoded calldata.
     * @param step The swap step parameters.
     * @param amountIn The input amount.
     * @return amountOut The output amount received.
     */
    function _executeZeroXSwap(
        IArbitrageExecutor.SwapStep memory step,
        uint256 amountIn
    ) internal returns (uint256 amountOut) {
        // Decode extraData: exchangeProxy, allowanceTarget, swapCalldata
        (address exchangeProxy, address allowanceTarget, bytes memory swapCalldata) =
            abi.decode(step.extraData, (address, address, bytes));

        // Approve the allowance target (may be different from exchange proxy for permit2)
        _safeApprove(step.tokenIn, allowanceTarget, amountIn);

        // Record balance before
        uint256 balanceBefore = IERC20(step.tokenOut).balanceOf(address(this));

        // Execute the 0x swap
        (bool success,) = exchangeProxy.call(swapCalldata);
        require(success, "0x swap failed");

        // Calculate output from balance difference
        uint256 balanceAfter = IERC20(step.tokenOut).balanceOf(address(this));
        amountOut = balanceAfter - balanceBefore;
    }

    // ─── Simulation Helpers ─────────────────────────────────────────────

    /**
     * @notice Simulates a single swap step output using on-chain state reads.
     * @param step The swap step to simulate.
     * @param amountIn The input amount.
     * @return amountOut The expected output amount.
     */
    function _simulateSwapStep(
        IArbitrageExecutor.SwapStep calldata step,
        uint256 amountIn
    ) internal view returns (uint256 amountOut) {
        if (step.dexId <= 2 || step.dexId == 6 || step.dexId == 8) {
            // V2-style simulation
            amountOut = _simulateV2Swap(step.pool, step.tokenIn, amountIn);
        } else if (step.dexId == 4) {
            // Aerodrome classic simulation
            amountOut = _simulateAerodromeSwap(step.pool, step.tokenIn, amountIn);
        } else if (step.dexId == 1 || step.dexId == 3 || step.dexId == 5 || step.dexId == 7 || step.dexId == 9) {
            // V3/CL simulation — use V2 approximation from reserves for view context
            // For accurate V3 simulation, use eth_call on the quoter off-chain
            amountOut = _simulateV3Approximate(step.pool, step.tokenIn, step.tokenOut, amountIn, step.fee);
        } else if (step.dexId == 10) {
            // 0x simulation — use the minAmountOut as the expected output
            // Real 0x quotes are fetched off-chain
            amountOut = step.minAmountOut;
        } else {
            amountOut = 0;
        }
    }

    /**
     * @notice Simulates a V2 swap using the constant product formula.
     * @param pool The V2 pair address.
     * @param tokenIn The input token.
     * @param amountIn The input amount.
     * @return amountOut The expected output.
     */
    function _simulateV2Swap(address pool, address tokenIn, uint256 amountIn)
        internal
        view
        returns (uint256 amountOut)
    {
        IUniswapV2Pair pair = IUniswapV2Pair(pool);
        (uint112 reserve0, uint112 reserve1,) = pair.getReserves();
        address token0 = pair.token0();

        bool isToken0In = tokenIn == token0;
        uint256 reserveIn = isToken0In ? uint256(reserve0) : uint256(reserve1);
        uint256 reserveOut = isToken0In ? uint256(reserve1) : uint256(reserve0);

        uint256 amountInWithFee = amountIn * 997;
        amountOut = (amountInWithFee * reserveOut) / (reserveIn * 1000 + amountInWithFee);
    }

    /**
     * @notice Simulates an Aerodrome classic pool swap using the pool's getAmountOut.
     * @param pool The Aerodrome pool address.
     * @param tokenIn The input token.
     * @param amountIn The input amount.
     * @return amountOut The expected output.
     */
    function _simulateAerodromeSwap(address pool, address tokenIn, uint256 amountIn)
        internal
        view
        returns (uint256 amountOut)
    {
        amountOut = IAerodromePool(pool).getAmountOut(amountIn, tokenIn);
    }

    /**
     * @notice Approximate V3 swap output using current sqrtPrice (single-tick approximation).
     * @dev This is an approximation for view-context simulation. For production accuracy,
     *      use the off-chain quoter via eth_call.
     * @param pool The V3 pool address.
     * @param tokenIn The input token.
     * @param tokenOut The output token (unused but kept for interface consistency).
     * @param amountIn The input amount.
     * @param fee The fee tier in hundredths of a bip.
     * @return amountOut The approximate output.
     */
    function _simulateV3Approximate(
        address pool,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint24 fee
    ) internal view returns (uint256 amountOut) {
        // Suppress unused variable warning
        tokenOut;

        // Read current sqrtPriceX96 and liquidity
        (uint160 sqrtPriceX96,,,,,,) = abi.decode(
            _staticCallPool(pool, abi.encodeWithSignature(
                "slot0()"
            )),
            (uint160, int24, uint16, uint16, uint16, uint8, bool)
        );

        uint128 liq = abi.decode(
            _staticCallPool(pool, abi.encodeWithSignature("liquidity()")),
            (uint128)
        );

        if (liq == 0 || sqrtPriceX96 == 0) return 0;

        address token0;
        try IUniswapV2Pair(pool).token0() returns (address t0) {
            token0 = t0;
        } catch {
            return 0;
        }

        // Apply fee
        uint256 amountInAfterFee = (amountIn * (1000000 - uint256(fee))) / 1000000;

        bool zeroForOne = tokenIn == token0;

        // Single-tick approximation using current price
        // price = (sqrtPriceX96 / 2^96)^2
        // For zeroForOne: amountOut ≈ amountIn * price
        // For oneForZero: amountOut ≈ amountIn / price
        if (zeroForOne) {
            // token0 -> token1: amountOut = amountIn * (sqrtPrice^2 / 2^192)
            uint256 priceNum = uint256(sqrtPriceX96) * uint256(sqrtPriceX96);
            amountOut = (amountInAfterFee * priceNum) >> 192;
        } else {
            // token1 -> token0: amountOut = amountIn * 2^192 / sqrtPrice^2
            uint256 priceNum = uint256(sqrtPriceX96) * uint256(sqrtPriceX96);
            if (priceNum == 0) return 0;
            amountOut = (amountInAfterFee << 192) / priceNum;
        }
    }

    /**
     * @notice Helper to perform a staticcall on a pool and return the raw data.
     * @param pool The pool address.
     * @param data The calldata.
     * @return The return data.
     */
    function _staticCallPool(address pool, bytes memory data) internal view returns (bytes memory) {
        (bool success, bytes memory returnData) = pool.staticcall(data);
        require(success, "Pool staticcall failed");
        return returnData;
    }

    // ─── Safe Token Operations ──────────────────────────────────────────

    /**
     * @notice Safely approves a spender for a given amount, resetting to 0 first.
     * @param token The ERC20 token address.
     * @param spender The spender address.
     * @param amount The amount to approve.
     */
    function _safeApprove(address token, address spender, uint256 amount) internal {
        // Reset approval to 0 first (required by some tokens like USDT)
        (bool successReset,) = token.call(abi.encodeWithSelector(IERC20.approve.selector, spender, 0));
        require(successReset, "Approve reset failed");

        // Set new approval
        (bool success, bytes memory data) = token.call(abi.encodeWithSelector(IERC20.approve.selector, spender, amount));
        require(success && (data.length == 0 || abi.decode(data, (bool))), "Approve failed");
    }

    /**
     * @notice Safely transfers tokens to a recipient.
     * @param token The ERC20 token address.
     * @param to The recipient address.
     * @param amount The amount to transfer.
     */
    function _safeTransfer(address token, address to, uint256 amount) internal {
        (bool success, bytes memory data) = token.call(
            abi.encodeWithSelector(IERC20.transfer.selector, to, amount)
        );
        require(success && (data.length == 0 || abi.decode(data, (bool))), "Transfer failed");
    }

    // ─── Admin Functions ────────────────────────────────────────────────

    /**
     * @notice Rescues tokens accidentally sent to the contract.
     * @param token The ERC20 token address to rescue.
     * @param amount The amount to rescue.
     */
    function rescueTokens(address token, uint256 amount) external onlyOwner nonReentrant {
        _safeTransfer(token, owner, amount);
        emit TokensRescued(token, amount, owner);
    }

    /**
     * @notice Updates the authorized executor address.
     * @param newExecutor The new executor address.
     */
    function updateAuthorizedExecutor(address newExecutor) external onlyOwner {
        if (newExecutor == address(0)) revert ZeroAddress();
        address oldExecutor = authorizedExecutor;
        authorizedExecutor = newExecutor;
        emit ExecutorUpdated(oldExecutor, newExecutor);
    }

    /**
     * @notice Updates the minimum profit threshold.
     * @param newMinProfit The new minimum profit in flash asset units.
     */
    function updateMinProfit(uint256 newMinProfit) external onlyOwner {
        uint256 oldMinProfit = minProfit;
        minProfit = newMinProfit;
        emit MinProfitUpdated(oldMinProfit, newMinProfit);
    }

    /**
     * @notice Updates a V2 router address.
     * @param dexId The DEX ID.
     * @param router The new router address.
     */
    function updateV2Router(uint8 dexId, address router) external onlyOwner {
        v2Routers[dexId] = router;
        emit RouterUpdated(dexId, false, router);
    }

    /**
     * @notice Updates a V3 router address.
     * @param dexId The DEX ID.
     * @param router The new router address.
     */
    function updateV3Router(uint8 dexId, address router) external onlyOwner {
        v3Routers[dexId] = router;
        emit RouterUpdated(dexId, true, router);
    }

    /**
     * @notice Transfers ownership of the contract.
     * @param newOwner The new owner address.
     */
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        address oldOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(oldOwner, newOwner);
    }

    // ─── Receive ────────────────────────────────────────────────────────

    /// @notice Allows the contract to receive ETH (e.g., from WETH unwrapping).
    receive() external payable {}
}