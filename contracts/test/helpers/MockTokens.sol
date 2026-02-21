// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

/**
 * @title MockERC20
 * @notice A minimal mock ERC20 token for unit tests that do not require real token interactions.
 */
contract MockERC20 {
    string public name;
    string public symbol;
    uint8 public decimals;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory _name, string memory _symbol, uint8 _decimals) {
        name = _name;
        symbol = _symbol;
        decimals = _decimals;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    function burn(address from, uint256 amount) external {
        require(balanceOf[from] >= amount, "Insufficient balance");
        balanceOf[from] -= amount;
        totalSupply -= amount;
        emit Transfer(from, address(0), amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "Insufficient balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "Insufficient balance");
        require(allowance[from][msg.sender] >= amount, "Insufficient allowance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}

/**
 * @title MockTokens
 * @notice Deploys mock ERC20 tokens for unit tests.
 */
contract MockTokens is Test {
    MockERC20 public mockUSDC;
    MockERC20 public mockWETH;
    MockERC20 public mockDAI;
    MockERC20 public mockUSDbC;
    MockERC20 public mockUSDT;
    MockERC20 public mockWBTC;

    function deployMockTokens() internal {
        mockUSDC = new MockERC20("USD Coin", "USDC", 6);
        mockWETH = new MockERC20("Wrapped Ether", "WETH", 18);
        mockDAI = new MockERC20("Dai Stablecoin", "DAI", 18);
        mockUSDbC = new MockERC20("USD Base Coin", "USDbC", 6);
        mockUSDT = new MockERC20("Tether USD", "USDT", 6);
        mockWBTC = new MockERC20("Wrapped BTC", "WBTC", 8);
    }

    function mintTokens(address to, uint256 usdcAmount, uint256 wethAmount) internal {
        mockUSDC.mint(to, usdcAmount);
        mockWETH.mint(to, wethAmount);
        mockDAI.mint(to, usdcAmount * 1e12); // Scale 6 decimals to 18
        mockUSDbC.mint(to, usdcAmount);
        mockUSDT.mint(to, usdcAmount);
        mockWBTC.mint(to, wethAmount / 10); // Approximate BTC amount
    }
}