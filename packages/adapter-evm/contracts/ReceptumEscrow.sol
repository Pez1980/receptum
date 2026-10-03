// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title ReceptumEscrow
/// @notice Holds an ERC-20 payment for one job until the seller delivers and the delivery is
///         accepted. The seller commits the Receptum receiptHash on delivery; the hash is the
///         on-chain anchor for the signed receipt (RRF v1, docs/SPEC.md §7).
/// @dev    Supports standard ERC-20s only: fee-on-transfer and rebasing tokens are rejected at
///         funding time because the received balance must equal `amount`.
///         Unaudited. Testnet use only until an independent audit is published.
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
    uint256 private locked = 1;

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
    error UnsupportedToken();
    error Reentrancy();

    modifier nonReentrant() {
        if (locked != 1) revert Reentrancy();
        locked = 2;
        _;
        locked = 1;
    }

    /// @notice Buyer locks `amount` of `token` for `seller`. Requires a prior ERC-20 approval.
    function open(
        address seller,
        address token,
        uint128 amount,
        uint64 deliverBy,
        uint32 reviewWindow,
        address evaluator
    ) external nonReentrant returns (uint256 id) {
        if (seller == address(0) || seller == msg.sender || amount == 0) revert InvalidArgs();
        if (evaluator == msg.sender || evaluator == seller) revert InvalidArgs();
        if (deliverBy <= block.timestamp) revert InvalidArgs();
        if (token.code.length == 0) revert UnsupportedToken();
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
        uint256 before = IERC20(token).balanceOf(address(this));
        _call(token, abi.encodeCall(IERC20.transferFrom, (msg.sender, address(this), amount)));
        if (IERC20(token).balanceOf(address(this)) - before != amount) revert UnsupportedToken();
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
    function accept(uint256 id) external nonReentrant {
        Escrow storage e = escrows[id];
        if (e.status != Status.Delivered) revert BadState();
        if (!_canJudge(e)) revert NotAllowed();
        _release(id, e);
    }

    /// @notice Buyer or evaluator rejects the delivery within the review window; the buyer is refunded.
    function reject(uint256 id) external nonReentrant {
        Escrow storage e = escrows[id];
        if (e.status != Status.Delivered) revert BadState();
        if (!_canJudge(e)) revert NotAllowed();
        if (block.timestamp >= uint256(e.deliveredAt) + e.reviewWindow) revert TooLate();
        _refund(id, e);
    }

    /// @notice Anyone can release to the seller once the review window has passed without rejection.
    function release(uint256 id) external nonReentrant {
        Escrow storage e = escrows[id];
        if (e.status != Status.Delivered) revert BadState();
        if (block.timestamp < uint256(e.deliveredAt) + e.reviewWindow) revert TooEarly();
        _release(id, e);
    }

    /// @notice Anyone can refund the buyer if nothing was delivered by the deadline.
    function refund(uint256 id) external nonReentrant {
        Escrow storage e = escrows[id];
        if (e.status != Status.Open) revert BadState();
        if (block.timestamp <= e.deliverBy) revert TooEarly();
        _refund(id, e);
    }

    /// @notice The seller may return the funds to the buyer at any time before release — e.g. to
    ///         settle a dispute, or when transfers to the seller are blocked by the token issuer.
    function sellerRefund(uint256 id) external nonReentrant {
        Escrow storage e = escrows[id];
        if (e.status != Status.Open && e.status != Status.Delivered) revert BadState();
        if (msg.sender != e.seller) revert NotAllowed();
        _refund(id, e);
    }

    function _canJudge(Escrow storage e) private view returns (bool) {
        return msg.sender == e.buyer || (e.evaluator != address(0) && msg.sender == e.evaluator);
    }

    function _release(uint256 id, Escrow storage e) private {
        e.status = Status.Released;
        emit Released(id, e.receiptHash, msg.sender);
        _call(e.token, abi.encodeCall(IERC20.transfer, (e.seller, e.amount)));
    }

    function _refund(uint256 id, Escrow storage e) private {
        e.status = Status.Refunded;
        emit Refunded(id, msg.sender);
        _call(e.token, abi.encodeCall(IERC20.transfer, (e.buyer, e.amount)));
    }

    /// @dev Calls an ERC-20 and accepts either no return data or an ABI-encoded `true`.
    function _call(address token, bytes memory data) private {
        (bool ok, bytes memory ret) = token.call(data);
        if (!ok) revert TransferFailed();
        if (ret.length != 0 && (ret.length != 32 || !abi.decode(ret, (bool)))) revert TransferFailed();
    }
}
