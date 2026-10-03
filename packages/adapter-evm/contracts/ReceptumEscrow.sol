// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title ReceptumEscrow
/// @notice Holds an ERC-20 payment for one job until the seller delivers and the delivery is
///         accepted. The seller commits the Receptum receiptHash on delivery; the hash is the
///         on-chain anchor for the signed receipt (RRF v1, docs/SPEC.md §7).
/// @dev    Unaudited. Testnet use only until an independent audit is published.
contract ReceptumEscrow {
    enum Status {
        None,
        Open,
        Delivered,
        Released,
        Refunded
    }

    struct Escrow {
        address buyer;
        address seller;
        address evaluator; // may accept or reject in addition to the buyer; zero = buyer only
        address token;
        uint128 amount;
        uint64 deliverBy; // seller must deliver by this time or the buyer can be refunded
        uint32 reviewWindow; // seconds after delivery before anyone can release to the seller
        uint64 deliveredAt;
        Status status;
        bytes32 receiptHash;
    }

    mapping(uint256 => Escrow) public escrows;
    uint256 public nextId = 1;

    event Opened(
        uint256 indexed id,
        address indexed buyer,
        address indexed seller,
        address token,
        uint256 amount,
        uint64 deliverBy,
        uint32 reviewWindow,
        address evaluator
    );
    event Delivered(uint256 indexed id, bytes32 indexed receiptHash);
    event Released(uint256 indexed id, bytes32 indexed receiptHash, address by);
    event Refunded(uint256 indexed id, address by);

    error BadState();
    error NotAllowed();
    error TooEarly();
    error TooLate();
    error InvalidArgs();
    error TransferFailed();

    /// @notice Buyer locks `amount` of `token` for `seller`. Requires a prior ERC-20 approval.
    function open(
        address seller,
        address token,
        uint128 amount,
        uint64 deliverBy,
        uint32 reviewWindow,
        address evaluator
    ) external returns (uint256 id) {
        if (seller == address(0) || seller == msg.sender || token == address(0) || amount == 0) revert InvalidArgs();
        if (deliverBy <= block.timestamp) revert InvalidArgs();
        id = nextId++;
        escrows[id] = Escrow({
            buyer: msg.sender,
            seller: seller,
            evaluator: evaluator,
            token: token,
            amount: amount,
            deliverBy: deliverBy,
            reviewWindow: reviewWindow,
            deliveredAt: 0,
            status: Status.Open,
            receiptHash: bytes32(0)
        });
        emit Opened(id, msg.sender, seller, token, amount, deliverBy, reviewWindow, evaluator);
        _pull(token, msg.sender, amount);
    }

    /// @notice Seller commits the receipt hash. Starts the review window.
    function deliver(uint256 id, bytes32 receiptHash) external {
        Escrow storage e = escrows[id];
        if (e.status != Status.Open) revert BadState();
        if (msg.sender != e.seller) revert NotAllowed();
        if (block.timestamp > e.deliverBy) revert TooLate();
        if (receiptHash == bytes32(0)) revert InvalidArgs();
        e.status = Status.Delivered;
        e.deliveredAt = uint64(block.timestamp);
        e.receiptHash = receiptHash;
        emit Delivered(id, receiptHash);
    }

    /// @notice Buyer or evaluator accepts the delivery; the seller is paid in full.
    function accept(uint256 id) external {
        Escrow storage e = escrows[id];
        if (e.status != Status.Delivered) revert BadState();
        if (!_canJudge(e)) revert NotAllowed();
        _release(id, e);
    }

    /// @notice Buyer or evaluator rejects the delivery within the review window; the buyer is refunded.
    function reject(uint256 id) external {
        Escrow storage e = escrows[id];
        if (e.status != Status.Delivered) revert BadState();
        if (!_canJudge(e)) revert NotAllowed();
        if (block.timestamp >= uint256(e.deliveredAt) + e.reviewWindow) revert TooLate();
        _refund(id, e);
    }

    /// @notice Anyone can release to the seller once the review window has passed without rejection.
    function release(uint256 id) external {
        Escrow storage e = escrows[id];
        if (e.status != Status.Delivered) revert BadState();
        if (block.timestamp < uint256(e.deliveredAt) + e.reviewWindow) revert TooEarly();
        _release(id, e);
    }

    /// @notice Anyone can refund the buyer if nothing was delivered by the deadline.
    function refund(uint256 id) external {
        Escrow storage e = escrows[id];
        if (e.status != Status.Open) revert BadState();
        if (block.timestamp <= e.deliverBy) revert TooEarly();
        _refund(id, e);
    }

    function _canJudge(Escrow storage e) private view returns (bool) {
        return msg.sender == e.buyer || (e.evaluator != address(0) && msg.sender == e.evaluator);
    }

    function _release(uint256 id, Escrow storage e) private {
        e.status = Status.Released;
        emit Released(id, e.receiptHash, msg.sender);
        _push(e.token, e.seller, e.amount);
    }

    function _refund(uint256 id, Escrow storage e) private {
        e.status = Status.Refunded;
        emit Refunded(id, msg.sender);
        _push(e.token, e.buyer, e.amount);
    }

    function _pull(address token, address from, uint256 amount) private {
        (bool ok, bytes memory data) =
            token.call(abi.encodeCall(IERC20.transferFrom, (from, address(this), amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _push(address token, address to, uint256 amount) private {
        (bool ok, bytes memory data) = token.call(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}
