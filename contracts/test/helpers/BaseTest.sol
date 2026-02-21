// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "./ForkHelper.sol";
import "./MockTokens.sol";
import "../../src/ArbitrageExecutor.sol";
import "../../src/interfaces/IArbitrageExecutor.sol";

/**
 * @title BaseTest
 * @notice Shared test base contract. Sets up fork, deals tokens, deploys the contract,
 *         and whitelists the test executor.
 */
contract BaseTest is Test, ForkHelper, MockTokens {
    // ─── Base Mainnet Addresses ─────────────────────────────────────────
    address public constant AAVE_V3_POOL = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5;
    address public constant WETH = 0x4200000000000000000000000000000000000006;
    address public constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address public constant USDbC = 0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA;
    address public constant DAI = 0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb;
    address public constant USDT = 0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2;
    address public constant cbETH = 0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22;
    address public constant wstETH = 0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452;

    // DEX Routers
    address public constant UNISWAP_V2_ROUTER = 0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24;
    address public constant UNISWAP_V3_ROUTER = 0x2626664c2603336E57B271c5C0b26F421741e481;
    address public constant SUSHISWAP_V2_ROUTER = 0x6BDED42c6DA8FBf0d2bA55B2fa120C5e0c8D7891;
    address public constant SUSHISWAP_V3_ROUTER = 0xFB7eF66a7e61224DD6FcD0D7d9C3be5C8B049b9f;
    address public constant AERODROME_ROUTER = 0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43;
    address public constant AERODROME_CL_ROUTER = 0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5;
    address public constant BASESWAP_V2_ROUTER = 0x327Df1E6de05895d2ab08513aaDD9313Fe505d86;
    address public constant BASESWAP_V3_ROUTER = 0x1B8eea9315bE495187D873DA7773a874545D9D48;
    address public constant PANCAKESWAP_V3_ROUTER = 0x1b81D678ffb9C0263b24A97847620C99d213eB14;

    // ─── Test State ─────────────────────────────────────────────────────
    ArbitrageExecutor public executor;
    address public testExecutor;
    uint256 public testExecutorKey;
    address public deployer;

    // ─── Setup ──────────────────────────────────────────────────────────

    function setUp() public virtual {
        // Create test accounts
        (testExecutor, testExecutorKey) = makeAddrAndKey("testExecutor");
        deployer = address(this);

        // Create Base mainnet fork
        string memory rpcUrl = getBaseRpcUrl();
        createBaseFork(rpcUrl);

        // Deploy ArbitrageExecutor
        _deployExecutor();

        // Fund test accounts
        _fundAccounts();
    }

    function _deployExecutor() internal {
        // V2 routers: UniV2(0), SushiV2(2), BaseSwapV2(6), SwapBased(8)
        uint8[] memory v2Ids = new uint8[](4);
        address[] memory v2Addrs = new address[](4);
        v2Ids[0] = 0; v2Addrs[0] = UNISWAP_V2_ROUTER;
        v2Ids[1] = 2; v2Addrs[1] = SUSHISWAP_V2_ROUTER;
        v2Ids[2] = 6; v2Addrs[2] = BASESWAP_V2_ROUTER;
        v2Ids[3] = 8; v2Addrs[3] = address(0); // SwapBased uses direct pair swaps

        // V3 routers: UniV3(1), SushiV3(3), BaseSwapV3(7), PancakeV3(9)
        uint8[] memory v3Ids = new uint8[](5);
        address[] memory v3Addrs = new address[](5);
        v3Ids[0] = 1; v3Addrs[0] = UNISWAP_V3_ROUTER;
        v3Ids[1] = 3; v3Addrs[1] = SUSHISWAP_V3_ROUTER;
        v3Ids[2] = 5; v3Addrs[2] = AERODROME_CL_ROUTER;
        v3Ids[3] = 7; v3Addrs[3] = BASESWAP_V3_ROUTER;
        v3Ids[4] = 9; v3Addrs[4] = PANCAKESWAP_V3_ROUTER;

        executor = new ArbitrageExecutor(
            AAVE_V3_POOL,
            testExecutor,
            0, // minProfit = 0 for testing
            v2Ids,
            v2Addrs,
            v3Ids,
            v3Addrs
        );
    }

    function _fundAccounts() internal {
        // Fund executor contract and test EOA with ETH
        vm.deal(address(executor), 10 ether);
        vm.deal(testExecutor, 10 ether);
        vm.deal(deployer, 10 ether);

        // Deal tokens to the executor contract for testing
        deal(USDC, address(executor), 1_000_000 * 1e6);
        deal(WETH, address(executor), 1000 * 1e18);
        deal(USDbC, address(executor), 1_000_000 * 1e6);
        deal(DAI, address(executor), 1_000_000 * 1e18);
    }

    // ─── Helpers ────────────────────────────────────────────────────────

    /**
     * @notice Builds a simple two-step swap path for testing.
     * @param flashAsset The flash loan asset.
     * @param flashAmount The flash loan amount.
     * @param step1 The first swap step.
     * @param step2 The second swap step.
     * @return params The FlashLoanParams struct.
     */
    function buildTwoStepParams(
        address flashAsset,
        uint256 flashAmount,
        IArbitrageExecutor.SwapStep memory step1,
        IArbitrageExecutor.SwapStep memory step2
    ) internal view returns (IArbitrageExecutor.FlashLoanParams memory params) {
        IArbitrageExecutor.SwapStep[] memory steps = new IArbitrageExecutor.SwapStep[](2);
        steps[0] = step1;
        steps[1] = step2;

        params = IArbitrageExecutor.FlashLoanParams({
            flashAsset: flashAsset,
            flashAmount: flashAmount,
            steps: steps,
            minReturnAmount: 0,
            deadline: block.timestamp + 300
        });
    }

    /**
     * @notice Creates a V2 swap step.
     */
    function makeV2Step(
        uint8 dexId,
        address tokenIn,
        address tokenOut,
        address pool,
        uint256 minAmountOut
    ) internal pure returns (IArbitrageExecutor.SwapStep memory) {
        return IArbitrageExecutor.SwapStep({
            dexId: dexId,
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            pool: pool,
            fee: 0,
            minAmountOut: minAmountOut,
            extraData: ""
        });
    }

    /**
     * @notice Creates a V3 swap step.
     */
    function makeV3Step(
        uint8 dexId,
        address tokenIn,
        address tokenOut,
        address pool,
        uint24 fee,
        uint256 minAmountOut
    ) internal pure returns (IArbitrageExecutor.SwapStep memory) {
        return IArbitrageExecutor.SwapStep({
            dexId: dexId,
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            pool: pool,
            fee: fee,
            minAmountOut: minAmountOut,
            extraData: ""
        });
    }

    /**
     * @notice Creates an Aerodrome swap step.
     */
    function makeAerodromeStep(
        address tokenIn,
        address tokenOut,
        address pool,
        bool stable,
        address factory
    ) internal pure returns (IArbitrageExecutor.SwapStep memory) {
        return IArbitrageExecutor.SwapStep({
            dexId: 4,
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            pool: pool,
            fee: 0,
            minAmountOut: 0,
            extraData: abi.encode(AERODROME_ROUTER, stable, factory)
        });
    }

    // Use a constant for AERODROME_ROUTER in extraData encoding
    address internal constant _AERO_ROUTER = 0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43;
}