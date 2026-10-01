// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {ITIP20} from "./ITIP20.sol";

/// @title TempexEscrow
/// @notice Escrow and settlement for agent-to-agent jobs on Tempo.
///
/// Lifecycle:
///   Created --fund--> Funded --deliver--> Delivered --accept/autoAccept--> Settled
///                                          |--dispute--> Disputed --respond (seller, <= 7 days)
///                                                                --resolve(verdict)--> Settled
///                                                                --settleLapsed (no verdict in time)--> Settled
///   Funded --refundExpired (delivery deadline missed)--> Refunded
///   Created --cancel--> Cancelled
///
/// Settlement is a pull pattern: rulings and acceptances credit balances, parties
/// withdraw stablecoins themselves. Disputes are settled by an arbiter whose
/// EIP-712 verdict is bound to the exact evidence bundle it evaluated.
///
/// A dispute opens a seller response window: the seller has
/// `SELLER_RESPONSE_WINDOW` to pin its own evidence that the work was done, and
/// no verdict can settle the job until the seller has responded or the window
/// has closed.
///
/// Every job locks its arbiter and fee rates at creation. Later admin changes
/// apply to new jobs only, so nobody can swap the judge or raise the fee on a
/// deal already in flight. If the arbiter never rules, `settleLapsed` lets
/// anyone close the dispute on a fixed default split with no arbitration fee.
///
/// Arbiters compete. Anyone can list itself as an arbiter with its own fee, and a
/// buyer can name a listed arbiter for a job with `createJobWithArbiter`; the
/// seller sees that choice on chain before it delivers. A listed arbiter earns
/// its fee minus the protocol's cut. Jobs created with `createJob` use the
/// house arbiter, whose whole fee goes to the treasury.
contract TempexEscrow is EIP712, Ownable2Step, ReentrancyGuard {
    uint16 public constant BPS_DENOMINATOR = 10_000;
    uint16 public constant MAX_PLATFORM_FEE_BPS = 500;
    uint16 public constant MAX_ARBITRATION_FEE_BPS = 1_000;
    /// @notice How long a seller has, from the moment a dispute is raised, to pin
    /// its evidence of proper delivery before the arbiter may rule.
    uint64 public constant SELLER_RESPONSE_WINDOW = 7 days;
    /// @notice How long the arbiter has to rule once the evidence record closes.
    /// After that the dispute lapses and anyone can settle it on the default split.
    uint64 public constant ARBITRATION_WINDOW = 7 days;
    /// @notice Seller share of a lapsed dispute. Even, and with no arbitration fee:
    /// an arbiter that never rules earns nothing, and neither party is punished
    /// for the arbiter's silence.
    uint16 public constant LAPSED_SELLER_AWARD_BPS = 5_000;
    /// @notice Longest review window a buyer may set; past this a buyer could
    /// hold delivered work hostage while keeping the option to dispute.
    uint64 public constant MAX_REVIEW_WINDOW = 30 days;
    /// @notice Most the protocol may take of a listed arbiter's fee.
    uint16 public constant MAX_PROTOCOL_CUT_BPS = 5_000;

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
        uint64 disputedAt;
        uint64 respondedAt;
        bytes32 responseHash;
        address arbiter;
        uint16 platformFeeBps;
        uint16 arbitrationFeeBps;
        /// share of the arbitration fee that goes to the treasury; the rest
        /// goes to the arbiter. 10000 for the house arbiter.
        uint16 protocolCutBps;
    }

    /// @notice A self-listed arbiter. `feeBps` applies to jobs created while it is
    /// listed; each job locks the fee it was created with.
    struct ArbiterListing {
        bool active;
        uint16 feeBps;
        string metadataURI;
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
    /// @notice Share of a listed arbiter's fee the treasury keeps, for new jobs.
    uint16 public protocolCutBps = 2_000;
    mapping(address arbiter => ArbiterListing) public arbiterListings;

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
    /// @notice The arbiter and fee rates this job settles under, fixed at creation.
    event JobTermsLocked(
        uint256 indexed jobId,
        address indexed arbiter,
        uint16 platformFeeBps,
        uint16 arbitrationFeeBps,
        uint16 protocolCutBps
    );
    event ArbiterListed(address indexed arbiter, uint16 feeBps, string metadataURI);
    event ArbiterDelisted(address indexed arbiter);
    event ProtocolCutUpdated(uint16 protocolCutBps);
    event DisputeLapsed(uint256 indexed jobId, uint256 sellerAmount, uint256 buyerAmount);
    event JobFunded(uint256 indexed jobId, uint256 amount);
    event JobCancelled(uint256 indexed jobId);
    event JobDelivered(
        uint256 indexed jobId, bytes32 deliverableHash, uint64 deliveredAt, uint64 reviewDeadline
    );
    event JobAccepted(uint256 indexed jobId, uint256 sellerAmount, uint256 platformFee);
    event DisputeRaised(uint256 indexed jobId, bytes32 disputeHash, uint64 disputedAt);
    /// @notice Tells the seller a dispute needs its answer, and by when.
    event SellerResponseRequested(
        uint256 indexed jobId, address indexed seller, uint64 responseDeadline
    );
    event SellerResponded(uint256 indexed jobId, bytes32 responseHash, uint64 respondedAt);
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

    /// @notice Creates a job judged by the house arbiter at the house fee.
    function createJob(
        address seller,
        uint256 amount,
        bytes32 termsHash,
        uint64 deliveryDeadline,
        uint64 reviewWindow
    ) external returns (uint256 jobId) {
        jobId = _createJob(seller, amount, termsHash, deliveryDeadline, reviewWindow);
        _lockTerms(jobId, arbiter, arbitrationFeeBps, BPS_DENOMINATOR);
    }

    /// @notice Creates a job judged by a listed arbiter of the buyer's choosing, at
    /// that arbiter's listed fee. Neither party may be its own judge.
    function createJobWithArbiter(
        address seller,
        uint256 amount,
        bytes32 termsHash,
        uint64 deliveryDeadline,
        uint64 reviewWindow,
        address chosenArbiter
    ) external returns (uint256 jobId) {
        ArbiterListing storage listing = arbiterListings[chosenArbiter];
        require(listing.active, "arbiter not listed");
        require(chosenArbiter != msg.sender && chosenArbiter != seller, "party cannot judge");
        jobId = _createJob(seller, amount, termsHash, deliveryDeadline, reviewWindow);
        _lockTerms(jobId, chosenArbiter, listing.feeBps, protocolCutBps);
    }

    function _createJob(
        address seller,
        uint256 amount,
        bytes32 termsHash,
        uint64 deliveryDeadline,
        uint64 reviewWindow
    ) private returns (uint256 jobId) {
        require(seller != address(0) && seller != msg.sender, "invalid seller");
        require(amount > 0, "amount=0");
        require(deliveryDeadline > block.timestamp, "deadline in past");
        require(reviewWindow > 0, "reviewWindow=0");
        require(reviewWindow <= MAX_REVIEW_WINDOW, "reviewWindow too long");

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

    function _lockTerms(uint256 jobId, address arbiter_, uint16 arbitrationFee, uint16 cut)
        private
    {
        Job storage job = _jobs[jobId];
        job.arbiter = arbiter_;
        job.platformFeeBps = platformFeeBps;
        job.arbitrationFeeBps = arbitrationFee;
        job.protocolCutBps = cut;
        emit JobTermsLocked(jobId, arbiter_, platformFeeBps, arbitrationFee, cut);
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
        uint256 fee = (job.amount * job.platformFeeBps) / BPS_DENOMINATOR;
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
        job.disputedAt = uint64(block.timestamp);

        emit DisputeRaised(jobId, disputeHash, job.disputedAt);
        emit SellerResponseRequested(jobId, job.seller, job.disputedAt + SELLER_RESPONSE_WINDOW);
    }

    /// @notice Seller pins the hash of its evidence bundle (proof the work was done
    /// properly) inside the response window. One response per dispute; once it
    /// lands, the arbiter may rule without waiting for the window to close.
    function respond(uint256 jobId, bytes32 responseHash) external {
        Job storage job = _jobs[jobId];
        require(job.state == JobState.Disputed, "not disputed");
        require(msg.sender == job.seller, "only seller");
        require(responseHash != bytes32(0), "responseHash=0");
        require(job.respondedAt == 0, "already responded");
        require(
            block.timestamp <= job.disputedAt + SELLER_RESPONSE_WINDOW, "response window closed"
        );

        job.respondedAt = uint64(block.timestamp);
        job.responseHash = responseHash;

        emit SellerResponded(jobId, responseHash, job.respondedAt);
    }

    /// @notice When the evidence record for a dispute closed: the seller's response
    /// time, or the end of the response window if the seller stayed silent. Zero
    /// while the window is still open and the seller has not responded.
    function evidenceClosedAt(uint256 jobId) public view returns (uint64) {
        Job storage job = _jobs[jobId];
        if (job.respondedAt != 0) return job.respondedAt;
        uint64 deadline = job.disputedAt + SELLER_RESPONSE_WINDOW;
        return block.timestamp > deadline ? deadline : 0;
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
        require(verdict.evidenceHash == job.disputeHash, "evidence is not the pinned dispute");
        require(verdict.sellerAwardBps <= BPS_DENOMINATOR, "awardBps>10000");
        require(verdict.issuedAt <= block.timestamp, "verdict not yet valid");
        require(block.timestamp <= verdict.validUntil, "verdict expired");
        // The seller gets its say before any ruling: a verdict can only settle the
        // job once the evidence record is closed, and only if it was issued after
        // that, so it cannot have been decided without the seller's evidence.
        _requireSellerHeard(jobId, verdict.issuedAt);

        bytes32 digest = verdictDigest(verdict);
        require(ECDSA.recover(digest, signature) == job.arbiter, "bad verdict signature");

        uint256 fee = (job.amount * job.arbitrationFeeBps) / BPS_DENOMINATOR;
        uint256 remaining = job.amount - fee;
        uint256 sellerAmount = (remaining * verdict.sellerAwardBps) / BPS_DENOMINATOR;
        uint256 buyerAmount = remaining - sellerAmount;

        job.state = JobState.Settled;
        job.verdictHash = digest;
        credits[job.seller] += sellerAmount;
        credits[job.buyer] += buyerAmount;
        _payArbitrationFee(job, fee);

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

    function _requireSellerHeard(uint256 jobId, uint64 issuedAt) private view {
        uint64 closedAt = evidenceClosedAt(jobId);
        require(closedAt != 0, "seller response window open");
        require(issuedAt >= closedAt, "verdict predates seller evidence");
        require(block.timestamp <= closedAt + ARBITRATION_WINDOW, "arbitration window lapsed");
    }

    /// @notice Closes a dispute the arbiter never ruled on. Permissionless, so a
    /// silent arbiter cannot lock funds: after `ARBITRATION_WINDOW` past the close
    /// of evidence, the job settles on `LAPSED_SELLER_AWARD_BPS` with no fee.
    function settleLapsed(uint256 jobId) external {
        Job storage job = _jobs[jobId];
        require(job.state == JobState.Disputed, "not disputed");
        uint64 closedAt = evidenceClosedAt(jobId);
        require(
            closedAt != 0 && block.timestamp > closedAt + ARBITRATION_WINDOW,
            "arbitration window open"
        );

        uint256 sellerAmount = (job.amount * LAPSED_SELLER_AWARD_BPS) / BPS_DENOMINATOR;
        uint256 buyerAmount = job.amount - sellerAmount;

        job.state = JobState.Settled;
        credits[job.seller] += sellerAmount;
        credits[job.buyer] += buyerAmount;

        emit DisputeLapsed(jobId, sellerAmount, buyerAmount);
    }

    function _payArbitrationFee(Job storage job, uint256 fee) private {
        uint256 protocolShare = (fee * job.protocolCutBps) / BPS_DENOMINATOR;
        credits[treasury] += protocolShare;
        credits[job.arbiter] += fee - protocolShare;
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

    // ------------------------------------------------------------ arbiters

    /// @notice Lists the caller as an arbiter, or updates its fee and metadata.
    /// A fee change reaches only jobs created afterwards.
    function listArbiter(uint16 feeBps, string calldata metadataURI) external {
        require(feeBps <= MAX_ARBITRATION_FEE_BPS, "arbitrationFee too high");
        arbiterListings[msg.sender] = ArbiterListing(true, feeBps, metadataURI);
        emit ArbiterListed(msg.sender, feeBps, metadataURI);
    }

    /// @notice Stops new jobs naming the caller. Jobs it already judges are unaffected.
    function delistArbiter() external {
        require(arbiterListings[msg.sender].active, "not listed");
        arbiterListings[msg.sender].active = false;
        emit ArbiterDelisted(msg.sender);
    }

    // --------------------------------------------------------------- admin

    /// @notice Treasury's share of listed arbiters' fees, for jobs created afterwards.
    function setProtocolCut(uint16 protocolCutBps_) external onlyOwner {
        require(protocolCutBps_ <= MAX_PROTOCOL_CUT_BPS, "protocolCut too high");
        protocolCutBps = protocolCutBps_;
        emit ProtocolCutUpdated(protocolCutBps_);
    }

    /// @notice Arbiter for jobs created after this call. Existing jobs keep theirs.
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

    /// @notice Fees apply to jobs created after this call; every existing job keeps
    /// the rates it locked at creation.
    function setFees(uint16 platformFeeBps_, uint16 arbitrationFeeBps_) external onlyOwner {
        require(platformFeeBps_ <= MAX_PLATFORM_FEE_BPS, "platformFee too high");
        require(arbitrationFeeBps_ <= MAX_ARBITRATION_FEE_BPS, "arbitrationFee too high");
        platformFeeBps = platformFeeBps_;
        arbitrationFeeBps = arbitrationFeeBps_;
        emit FeesUpdated(platformFeeBps_, arbitrationFeeBps_);
    }
}
