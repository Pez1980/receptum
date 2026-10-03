// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {ReceptumEscrow} from "../ReceptumEscrow.sol";

/// Minimal ERC-20 base with overridable hooks for adversarial behaviour.
contract BaseToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }

    function _move(address from, address to, uint256 a) internal virtual { balanceOf[from] -= a; balanceOf[to] += a; }

    function transfer(address to, uint256 a) external virtual returns (bool) { _move(msg.sender, to, a); return true; }
    function transferFrom(address from, address to, uint256 a) external virtual returns (bool) {
        allowance[from][msg.sender] -= a; _move(from, to, a); return true;
    }
}

/// Takes a 1% fee on every transfer.
contract FeeToken is BaseToken {
    function _move(address from, address to, uint256 a) internal override {
        uint256 fee = a / 100;
        balanceOf[from] -= a; balanceOf[to] += a - fee;
    }
}

/// USDT-style: no return value.
contract NoReturnToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function approve(address s, uint256 a) external { allowance[msg.sender][s] = a; }
    function transfer(address to, uint256 a) external { balanceOf[msg.sender] -= a; balanceOf[to] += a; }
    function transferFrom(address from, address to, uint256 a) external {
        allowance[from][msg.sender] -= a; balanceOf[from] -= a; balanceOf[to] += a;
    }
}

/// Returns 64 bytes instead of a bool.
contract MalformedReturnToken is BaseToken {
    function transfer(address to, uint256 a) external override returns (bool) {
        _move(msg.sender, to, a);
        assembly { mstore(0, 1) mstore(32, 1) return(0, 64) }
    }
}

/// Re-enters the escrow during a payout.
contract ReentrantToken is BaseToken {
    ReceptumEscrow public target;
    uint256 public targetId;
    function arm(ReceptumEscrow t, uint256 id) external { target = t; targetId = id; }
    function transfer(address to, uint256 a) external override returns (bool) {
        if (address(target) != address(0)) {
            ReceptumEscrow t = target;
            target = ReceptumEscrow(address(0));
            t.release(targetId);
        }
        _move(msg.sender, to, a);
        return true;
    }
}

/// Issuer can block transfers to an address (like USDC's blocklist).
contract BlockableToken is BaseToken {
    mapping(address => bool) public blocked;
    function setBlocked(address a, bool b) external { blocked[a] = b; }
    function transfer(address to, uint256 a) external override returns (bool) {
        require(!blocked[to], "blocked");
        _move(msg.sender, to, a);
        return true;
    }
}

contract AdversarialTokensTest is Test {
    ReceptumEscrow escrow;
    address buyer = address(0xB0B);
    address seller = address(0x5E11);
    address evaluator = address(0xE7A1);
    bytes32 constant RH = keccak256("receipt");

    function setUp() public { escrow = new ReceptumEscrow(); }

    function _fund(BaseToken t) internal {
        t.mint(buyer, 1_000_000);
        vm.prank(buyer);
        t.approve(address(escrow), type(uint256).max);
    }

    function _open(address token, uint128 amount) internal returns (uint256) {
        vm.prank(buyer);
        return escrow.open(seller, token, amount, uint64(block.timestamp + 1 hours), 1 days, address(0));
    }

    function test_rejects_eoa_token() public {
        vm.prank(buyer);
        vm.expectRevert(ReceptumEscrow.UnsupportedToken.selector);
        escrow.open(seller, address(0xDEAD), 100, uint64(block.timestamp + 1 hours), 1 days, address(0));
    }

    function test_rejects_fee_on_transfer_token() public {
        FeeToken t = new FeeToken();
        _fund(t);
        vm.prank(buyer);
        vm.expectRevert(ReceptumEscrow.UnsupportedToken.selector);
        escrow.open(seller, address(t), 10_000, uint64(block.timestamp + 1 hours), 1 days, address(0));
    }

    function test_supports_no_return_token() public {
        NoReturnToken t = new NoReturnToken();
        t.mint(buyer, 1_000_000);
        vm.prank(buyer);
        t.approve(address(escrow), type(uint256).max);
        uint256 id = _open(address(t), 500);
        vm.prank(seller);
        escrow.deliver(id, RH);
        vm.prank(buyer);
        escrow.accept(id);
        assertEq(t.balanceOf(seller), 500);
    }

    function test_rejects_malformed_return_data() public {
        MalformedReturnToken t = new MalformedReturnToken();
        _fund(t);
        uint256 id = _open(address(t), 500);
        vm.prank(seller);
        escrow.deliver(id, RH);
        vm.prank(buyer);
        vm.expectRevert(ReceptumEscrow.TransferFailed.selector);
        escrow.accept(id);
    }

    function test_blocks_reentrancy_during_payout() public {
        ReentrantToken t = new ReentrantToken();
        _fund(t);
        uint256 a = _open(address(t), 500);
        uint256 b = _open(address(t), 500);
        vm.startPrank(seller);
        escrow.deliver(a, RH);
        escrow.deliver(b, RH);
        vm.stopPrank();
        vm.warp(block.timestamp + 2 days);
        t.arm(escrow, b);
        vm.expectRevert(ReceptumEscrow.TransferFailed.selector);
        escrow.release(a);
        assertEq(t.balanceOf(address(escrow)), 1000);
    }

    function test_seller_refund_unsticks_funds_when_seller_is_blocked() public {
        BlockableToken t = new BlockableToken();
        _fund(t);
        uint256 id = _open(address(t), 500);
        vm.prank(seller);
        escrow.deliver(id, RH);
        vm.warp(block.timestamp + 2 days);
        t.setBlocked(seller, true);
        vm.expectRevert(ReceptumEscrow.TransferFailed.selector);
        escrow.release(id);
        vm.prank(seller);
        escrow.sellerRefund(id);
        assertEq(t.balanceOf(buyer), 1_000_000);
    }

    function test_only_seller_can_seller_refund() public {
        BaseToken t = new BaseToken();
        _fund(t);
        uint256 id = _open(address(t), 500);
        vm.prank(buyer);
        vm.expectRevert(ReceptumEscrow.NotAllowed.selector);
        escrow.sellerRefund(id);
    }

    function test_evaluator_cannot_be_seller_or_buyer() public {
        BaseToken t = new BaseToken();
        _fund(t);
        vm.startPrank(buyer);
        vm.expectRevert(ReceptumEscrow.InvalidArgs.selector);
        escrow.open(seller, address(t), 500, uint64(block.timestamp + 1 hours), 1 days, seller);
        vm.expectRevert(ReceptumEscrow.InvalidArgs.selector);
        escrow.open(seller, address(t), 500, uint64(block.timestamp + 1 hours), 1 days, buyer);
        vm.stopPrank();
    }

    function test_zero_review_window_releases_immediately() public {
        BaseToken t = new BaseToken();
        _fund(t);
        vm.prank(buyer);
        uint256 id = escrow.open(seller, address(t), 500, uint64(block.timestamp + 1 hours), 0, address(0));
        vm.prank(seller);
        escrow.deliver(id, RH);
        escrow.release(id);
        assertEq(t.balanceOf(seller), 500);
    }

    function test_nonexistent_escrow_reverts() public {
        vm.expectRevert(ReceptumEscrow.BadState.selector);
        escrow.release(999);
        vm.expectRevert(ReceptumEscrow.BadState.selector);
        escrow.refund(999);
    }

    /// Two escrows in the same token stay independently solvent.
    function testFuzz_multi_escrow_solvency(uint64 a1, uint64 a2, bool acceptFirst) public {
        BaseToken t = new BaseToken();
        _fund(t);
        a1 = uint64(bound(a1, 1, 400_000));
        a2 = uint64(bound(a2, 1, 400_000));
        uint256 x = _open(address(t), a1);
        uint256 y = _open(address(t), a2);
        vm.startPrank(seller);
        escrow.deliver(x, RH);
        escrow.deliver(y, RH);
        vm.stopPrank();
        vm.prank(buyer);
        if (acceptFirst) escrow.accept(x); else escrow.reject(x);
        assertEq(t.balanceOf(address(escrow)), a2);
        vm.warp(block.timestamp + 2 days);
        escrow.release(y);
        assertEq(t.balanceOf(address(escrow)), 0);
        assertEq(t.balanceOf(buyer) + t.balanceOf(seller), 1_000_000);
    }
}
