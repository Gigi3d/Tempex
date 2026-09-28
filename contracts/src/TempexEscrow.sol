// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {ITIP20} from "./ITIP20.sol";

/// @title TempexEscrow
/// @notice Escrow and settlement for agent-to-agent jobs on Tempo.
///
/// Lifecycle:
///   Created --fund--> Funded --deliver--> Delivered --accept/autoAccept--> Settled
///                                          |--dispute--> Disputed --resolve(verdict)--> Settled
///   Funded --refundExpired (delivery deadline missed)--> Refunded
///   Created --cancel--> Cancelled
///
/// Settlement is a pull pattern: rulings and acceptances credit balances, parties
/// withdraw stablecoins themselves. Disputes are settled by an arbiter whose
/// EIP-712 verdict is bound to the exact evidence bundle it evaluated.
contract TempexEscrow is EIP712, Ownable, ReentrancyGuard {
    uint16 public constant BPS_DENOMINATOR = 10_000;
    uint16 public constant MAX_PLATFORM_FEE_BPS = 500;
    uint16 public constant MAX_ARBITRATION_FEE_BPS = 1_000;

    /// @dev Memo tag on settlement withdrawals. Funding memos carry the job id itself,
    /// so an indexer can reconcile a transfer to a job without reading contract logs.
    bytes32 public constant WITHDRAW_MEMO = bytes32("tempex.withdraw");

    enum JobState {
        Created,
        Funded,
        Delivered,
        Disputed,
        Settled,
        Refunded,
        Cancelled
    }

    struct Job {
        address buyer;
        address seller;
        uint256 amount;
        uint64 deliveryDeadline;
        uint64 reviewWindow;
        uint64 deliveredAt;
        JobState state;
        bytes32 termsHash;
        bytes32 deliverableHash;
        bytes32 disputeHash;
        bytes32 verdictHash;
    }

    /// @notice Arbiter ruling over a disputed job.
    /// @param jobId disputed job
    /// @param sellerAwardBps share of the disputed amount awarded to the seller (0..10000)
    /// @param evidenceHash keccak256 of the evidence bundle the arbiter evaluated
    /// @param rationaleHash keccak256 of the written rationale backing the ruling
    /// @param issuedAt unix time the verdict becomes valid
    /// @param validUntil unix time the verdict stops being valid
    struct Verdict {
        uint256 jobId;
        uint16 sellerAwardBps;
        bytes32 evidenceHash;
        bytes32 rationaleHash;
        uint64 issuedAt;
        uint64 validUntil;
    }

    bytes32 private constant VERDICT_TYPEHASH = keccak256(
        "Verdict(uint256 jobId,uint16 sellerAwardBps,bytes32 evidenceHash,bytes32 rationaleHash,uint64 issuedAt,uint64 validUntil)"
    );

    ITIP20 public immutable paymentToken;
    address public arbiter;
    address public treasury;
    uint16 public platformFeeBps;
    uint16 public arbitrationFeeBps;

    uint256 public jobCount;
    mapping(uint256 jobId => Job) private _jobs;
    mapping(address account => uint256 amount) public credits;

    event JobCreated(
        uint256 indexed jobId,
        address indexed buyer,
        address indexed seller,
        uint256 amount,
        bytes32 termsHash,
        uint64 deliveryDeadline,
        uint64 reviewWindow
    );
    event JobFunded(uint256 indexed jobId, uint256 amount);
    event JobCancelled(uint256 indexed jobId);
    event JobDelivered(
        uint256 indexed jobId, bytes32 deliverableHash, uint64 deliveredAt, uint64 reviewDeadline
    );
    event JobAccepted(uint256 indexed jobId, uint256 sellerAmount, uint256 platformFee);
    event DisputeRaised(uint256 indexed jobId, bytes32 disputeHash, uint64 disputedAt);
    event VerdictResolved(
        uint256 indexed jobId,
        uint16 sellerAwardBps,
        uint256 sellerAmount,
        uint256 buyerAmount,
        uint256 arbitrationFee,
        bytes32 evidenceHash,
        bytes32 rationaleHash,
        bytes32 verdictDigest
    );
    event JobRefunded(uint256 indexed jobId, uint256 amount);
    event Withdrawal(address indexed account, uint256 amount);
    event ArbiterUpdated(address indexed arbiter);
    event TreasuryUpdated(address indexed treasury);
    event FeesUpdated(uint16 platformFeeBps, uint16 arbitrationFeeBps);

    constructor(
        ITIP20 paymentToken_,
        address owner_,
        address arbiter_,
        address treasury_,
        uint16 platformFeeBps_,
        uint16 arbitrationFeeBps_
    ) EIP712("Tempex", "1") Ownable(owner_) {
        require(address(paymentToken_) != address(0), "token=0");
        require(arbiter_ != address(0), "arbiter=0");
        require(treasury_ != address(0), "treasury=0");
        require(platformFeeBps_ <= MAX_PLATFORM_FEE_BPS, "platformFee too high");
        require(arbitrationFeeBps_ <= MAX_ARBITRATION_FEE_BPS, "arbitrationFee too high");
        paymentToken = paymentToken_;
        arbiter = arbiter_;
        treasury = treasury_;
        platformFeeBps = platformFeeBps_;
        arbitrationFeeBps = arbitrationFeeBps_;
    }

    // ---------------------------------------------------------------- jobs

    function createJob(
        address seller,
        uint256 amount,
        bytes32 termsHash,
        uint64 deliveryDeadline,
        uint64 reviewWindow
    ) external returns (uint256 jobId) {
        require(seller != address(0) && seller != msg.sender, "invalid seller");
        require(amount > 0, "amount=0");
        require(deliveryDeadline > block.timestamp, "deadline in past");
        require(reviewWindow > 0, "reviewWindow=0");

        jobId = ++jobCount;
        Job storage job = _jobs[jobId];
        job.buyer = msg.sender;
        job.seller = seller;
        job.amount = amount;
        job.deliveryDeadline = deliveryDeadline;
        job.reviewWindow = reviewWindow;
        job.state = JobState.Created;
        job.termsHash = termsHash;

        emit JobCreated(
            jobId, msg.sender, seller, amount, termsHash, deliveryDeadline, reviewWindow
        );
    }

    function fund(uint256 jobId) external nonReentrant {
        Job storage job = _jobs[jobId];
        require(job.state == JobState.Created, "not open");
        require(msg.sender == job.buyer, "only buyer");
        require(block.timestamp < job.deliveryDeadline, "deadline passed");

        job.state = JobState.Funded;
        // TIP-20 reverts on failure and returns nothing, so no bool check is needed.
        // The memo is the job id: the payment itself carries the reconciliation key.
        paymentToken.transferFromWithMemo(msg.sender, address(this), job.amount, bytes32(jobId));
        emit JobFunded(jobId, job.amount);
    }

    function cancel(uint256 jobId) external {
        Job storage job = _jobs[jobId];
        require(job.state == JobState.Created, "not open");
        require(msg.sender == job.buyer, "only buyer");

        job.state = JobState.Cancelled;
        emit JobCancelled(jobId);
    }

    function deliver(uint256 jobId, bytes32 deliverableHash) external {
        Job storage job = _jobs[jobId];
        require(job.state == JobState.Funded, "not funded");
        require(msg.sender == job.seller, "only seller");
        require(block.timestamp <= job.deliveryDeadline, "delivery deadline passed");

        job.state = JobState.Delivered;
        job.deliverableHash = deliverableHash;
        job.deliveredAt = uint64(block.timestamp);

        emit JobDelivered(
            jobId, deliverableHash, job.deliveredAt, job.deliveredAt + job.reviewWindow
        );
    }

    /// @notice Buyer accepts the delivery; seller is paid minus the platform fee.
    function accept(uint256 jobId) external {
        Job storage job = _jobs[jobId];
        require(job.state == JobState.Delivered, "not delivered");
        require(msg.sender == job.buyer, "only buyer");
        _settleAccepted(jobId, job);
    }

    /// @notice After the review window closes without a dispute, the delivery settles
    /// to the seller. Callable by anyone so a keeper can close idle jobs.
    function autoAccept(uint256 jobId) external {
        Job storage job = _jobs[jobId];
        require(job.state == JobState.Delivered, "not delivered");
        require(block.timestamp >= job.deliveredAt + job.reviewWindow, "review window open");
        _settleAccepted(jobId, job);
    }

    function _settleAccepted(uint256 jobId, Job storage job) private {
        uint256 fee = (job.amount * platformFeeBps) / BPS_DENOMINATOR;
        uint256 sellerAmount = job.amount - fee;

        job.state = JobState.Settled;
        credits[job.seller] += sellerAmount;
        credits[treasury] += fee;

        emit JobAccepted(jobId, sellerAmount, fee);
    }

    /// @notice Buyer disputes a delivery inside the review window. The claim bundle
    /// hash is pinned on-chain so the arbiter's ruling references fixed evidence.
    function dispute(uint256 jobId, bytes32 disputeHash) external {
        Job storage job = _jobs[jobId];
        require(job.state == JobState.Delivered, "not delivered");
        require(msg.sender == job.buyer, "only buyer");
        require(block.timestamp <= job.deliveredAt + job.reviewWindow, "review window closed");

        job.state = JobState.Disputed;
        job.disputeHash = disputeHash;

        emit DisputeRaised(jobId, disputeHash, uint64(block.timestamp));
    }

    /// @notice Executes a signed arbiter verdict. Permissionless: either party (or a
    /// keeper) can relay it, but only the registered arbiter's signature is accepted.
    function resolve(uint256 jobId, Verdict calldata verdict, bytes calldata signature)
        external
        nonReentrant
    {
        Job storage job = _jobs[jobId];
        require(job.state == JobState.Disputed, "not disputed");
        require(verdict.jobId == jobId, "jobId mismatch");
        require(verdict.sellerAwardBps <= BPS_DENOMINATOR, "awardBps>10000");
        require(verdict.issuedAt <= block.timestamp, "verdict not yet valid");
        require(block.timestamp <= verdict.validUntil, "verdict expired");

        bytes32 digest = verdictDigest(verdict);
        require(ECDSA.recover(digest, signature) == arbiter, "bad verdict signature");

        uint256 fee = (job.amount * arbitrationFeeBps) / BPS_DENOMINATOR;
        uint256 remaining = job.amount - fee;
        uint256 sellerAmount = (remaining * verdict.sellerAwardBps) / BPS_DENOMINATOR;
        uint256 buyerAmount = remaining - sellerAmount;

        job.state = JobState.Settled;
        job.verdictHash = digest;
        credits[job.seller] += sellerAmount;
        credits[job.buyer] += buyerAmount;
        credits[treasury] += fee;

        emit VerdictResolved(
            jobId,
            verdict.sellerAwardBps,
            sellerAmount,
            buyerAmount,
            fee,
            verdict.evidenceHash,
            verdict.rationaleHash,
            digest
        );
    }

    /// @notice Refunds the buyer when the seller misses the delivery deadline.
    /// Callable by anyone so a keeper can release stuck funds.
    function refundExpired(uint256 jobId) external {
        Job storage job = _jobs[jobId];
        require(job.state == JobState.Funded, "not funded");
        require(block.timestamp > job.deliveryDeadline, "deadline not passed");

        job.state = JobState.Refunded;
        credits[job.buyer] += job.amount;

        emit JobRefunded(jobId, job.amount);
    }

    // ---------------------------------------------------------- settlement

    function withdraw() external nonReentrant returns (uint256 amount) {
        amount = credits[msg.sender];
        require(amount > 0, "nothing to withdraw");
        credits[msg.sender] = 0;
        paymentToken.transferWithMemo(msg.sender, amount, WITHDRAW_MEMO);
        emit Withdrawal(msg.sender, amount);
    }

    // -------------------------------------------------------------- views

    /// @notice id the next `createJob` will mint. Clients batching
    /// `createJob` + `fund` in one Tempo transaction read this to build the
    /// `fund` calldata, since batched calls cannot see each other's return values.
    function nextJobId() external view returns (uint256) {
        return jobCount + 1;
    }

    function getJob(uint256 jobId) external view returns (Job memory) {
        return _jobs[jobId];
    }

    /// @notice EIP-712 digest the arbiter signs. Exposed so clients can verify
    /// their off-chain signing matches the on-chain expectation.
    function verdictDigest(Verdict calldata verdict) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    VERDICT_TYPEHASH,
                    verdict.jobId,
                    verdict.sellerAwardBps,
                    verdict.evidenceHash,
                    verdict.rationaleHash,
                    verdict.issuedAt,
                    verdict.validUntil
                )
            )
        );
    }

    // --------------------------------------------------------------- admin

    function setArbiter(address arbiter_) external onlyOwner {
        require(arbiter_ != address(0), "arbiter=0");
        arbiter = arbiter_;
        emit ArbiterUpdated(arbiter_);
    }

    function setTreasury(address treasury_) external onlyOwner {
        require(treasury_ != address(0), "treasury=0");
        treasury = treasury_;
        emit TreasuryUpdated(treasury_);
    }

    /// @notice Fees apply to jobs settled after this call; open jobs are unaffected.
    function setFees(uint16 platformFeeBps_, uint16 arbitrationFeeBps_) external onlyOwner {
        require(platformFeeBps_ <= MAX_PLATFORM_FEE_BPS, "platformFee too high");
        require(arbitrationFeeBps_ <= MAX_ARBITRATION_FEE_BPS, "arbitrationFee too high");
        platformFeeBps = platformFeeBps_;
        arbitrationFeeBps = arbitrationFeeBps_;
        emit FeesUpdated(platformFeeBps_, arbitrationFeeBps_);
    }
}
