// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {ReceptumEscrow} from "../ReceptumEscrow.sol";

contract MockUSDC {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    bool public failTransfers;

    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function setFail(bool f) external { failTransfers = f; }
    function approve(address spender, uint256 amount) external returns (bool) { allowance[msg.sender][spender] = amount; return true; }
    function transfer(address to, uint256 amount) external returns (bool) {
        if (failTransfers) return false;
        balanceOf[msg.sender] -= amount; balanceOf[to] += amount; return true;
    }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (failTransfers) return false;
        allowance[from][msg.sender] -= amount; balanceOf[from] -= amount; balanceOf[to] += amount; return true;
    }
}

contract ReceptumEscrowTest is Test {
    ReceptumEscrow escrow;
    MockUSDC usdc;
    address buyer = address(0xB0B);
    address seller = address(0x5E11);
    address evaluator = address(0xE7A1);
    address stranger = address(0xBAD);
    bytes32 constant RH = keccak256("receipt");
    uint128 constant AMT = 2_500_000;

    function setUp() public {
        escrow = new ReceptumEscrow();
        usdc = new MockUSDC();
        usdc.mint(buyer, 10_000_000);
        vm.prank(buyer);
        usdc.approve(address(escrow), type(uint256).max);
    }

    function _open(address eval) internal returns (uint256 id) {
        vm.prank(buyer);
        id = escrow.open(seller, address(usdc), AMT, uint64(block.timestamp + 1 hours), 1 days, eval);
    }

    function _status(uint256 id) internal view returns (ReceptumEscrow.Status s) {
        (,,,,,,,, s,) = escrow.escrows(id);
    }

    function test_open_pulls_funds() public {
        uint256 id = _open(address(0));
        assertEq(id, 1);
        assertEq(usdc.balanceOf(address(escrow)), AMT);
        assertEq(uint8(_status(id)), uint8(ReceptumEscrow.Status.Open));
    }

    function test_open_rejects_bad_args() public {
        vm.startPrank(buyer);
        vm.expectRevert(ReceptumEscrow.InvalidArgs.selector);
        escrow.open(buyer, address(usdc), AMT, uint64(block.timestamp + 1), 1, address(0));
        vm.expectRevert(ReceptumEscrow.InvalidArgs.selector);
        escrow.open(seller, address(usdc), 0, uint64(block.timestamp + 1), 1, address(0));
        vm.expectRevert(ReceptumEscrow.InvalidArgs.selector);
        escrow.open(seller, address(usdc), AMT, uint64(block.timestamp), 1, address(0));
        vm.stopPrank();
    }

    function test_happy_path_buyer_accepts() public {
        uint256 id = _open(address(0));
        vm.prank(seller);
        escrow.deliver(id, RH);
        vm.prank(buyer);
        escrow.accept(id);
        assertEq(usdc.balanceOf(seller), AMT);
        assertEq(uint8(_status(id)), uint8(ReceptumEscrow.Status.Released));
    }

    function test_evaluator_can_accept_and_reject() public {
        uint256 a = _open(evaluator);
        vm.prank(seller);
        escrow.deliver(a, RH);
        vm.prank(evaluator);
        escrow.accept(a);
        assertEq(usdc.balanceOf(seller), AMT);

        uint256 b = _open(evaluator);
        vm.prank(seller);
        escrow.deliver(b, RH);
        vm.prank(evaluator);
        escrow.reject(b);
        assertEq(usdc.balanceOf(buyer), 10_000_000 - AMT);
    }

    function test_only_seller_delivers() public {
        uint256 id = _open(address(0));
        vm.prank(stranger);
        vm.expectRevert(ReceptumEscrow.NotAllowed.selector);
        escrow.deliver(id, RH);
    }

    function test_deliver_rejects_zero_hash_and_late_delivery() public {
        uint256 id = _open(address(0));
        vm.prank(seller);
        vm.expectRevert(ReceptumEscrow.InvalidArgs.selector);
        escrow.deliver(id, bytes32(0));
        vm.warp(block.timestamp + 1 hours + 1);
        vm.prank(seller);
        vm.expectRevert(ReceptumEscrow.TooLate.selector);
        escrow.deliver(id, RH);
    }

    function test_strangers_cannot_judge() public {
        uint256 id = _open(address(0));
        vm.prank(seller);
        escrow.deliver(id, RH);
        vm.startPrank(stranger);
        vm.expectRevert(ReceptumEscrow.NotAllowed.selector);
        escrow.accept(id);
        vm.expectRevert(ReceptumEscrow.NotAllowed.selector);
        escrow.reject(id);
        vm.stopPrank();
    }

    function test_auto_release_after_review_window() public {
        uint256 id = _open(address(0));
        vm.prank(seller);
        escrow.deliver(id, RH);
        vm.expectRevert(ReceptumEscrow.TooEarly.selector);
        escrow.release(id);
        vm.warp(block.timestamp + 1 days);
        vm.prank(stranger);
        escrow.release(id);
        assertEq(usdc.balanceOf(seller), AMT);
    }

    function test_reject_closes_with_window() public {
        uint256 id = _open(address(0));
        vm.prank(seller);
        escrow.deliver(id, RH);
        vm.warp(block.timestamp + 1 days);
        vm.prank(buyer);
        vm.expectRevert(ReceptumEscrow.TooLate.selector);
        escrow.reject(id);
    }

    function test_refund_only_after_deadline_without_delivery() public {
        uint256 id = _open(address(0));
        vm.expectRevert(ReceptumEscrow.TooEarly.selector);
        escrow.refund(id);
        vm.warp(block.timestamp + 1 hours + 1);
        vm.prank(stranger);
        escrow.refund(id);
        assertEq(usdc.balanceOf(buyer), 10_000_000);
    }

    function test_no_refund_after_delivery_and_no_double_spend() public {
        uint256 id = _open(address(0));
        vm.prank(seller);
        escrow.deliver(id, RH);
        vm.warp(block.timestamp + 2 hours);
        vm.expectRevert(ReceptumEscrow.BadState.selector);
        escrow.refund(id);
        vm.prank(buyer);
        escrow.accept(id);
        vm.expectRevert(ReceptumEscrow.BadState.selector);
        escrow.release(id);
        vm.prank(buyer);
        vm.expectRevert(ReceptumEscrow.BadState.selector);
        escrow.accept(id);
        assertEq(usdc.balanceOf(seller), AMT);
        assertEq(usdc.balanceOf(address(escrow)), 0);
    }

    function test_reverts_when_token_returns_false() public {
        usdc.setFail(true);
        vm.prank(buyer);
        vm.expectRevert(ReceptumEscrow.TransferFailed.selector);
        escrow.open(seller, address(usdc), AMT, uint64(block.timestamp + 1 hours), 1 days, address(0));
    }

    function testFuzz_funds_are_conserved(uint128 amount, bool deliver, bool accept) public {
        amount = uint128(bound(amount, 1, 10_000_000));
        vm.prank(buyer);
        uint256 id = escrow.open(seller, address(usdc), amount, uint64(block.timestamp + 1 hours), 1 days, address(0));
        if (deliver) {
            vm.prank(seller);
            escrow.deliver(id, RH);
            if (accept) { vm.prank(buyer); escrow.accept(id); }
            else { vm.prank(buyer); escrow.reject(id); }
        } else {
            vm.warp(block.timestamp + 2 hours);
            escrow.refund(id);
        }
        assertEq(usdc.balanceOf(buyer) + usdc.balanceOf(seller), 10_000_000);
        assertEq(usdc.balanceOf(address(escrow)), 0);
    }
}
