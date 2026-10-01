// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ITIP20} from "../src/ITIP20.sol";
import {TempexEscrow} from "../src/TempexEscrow.sol";

/// @dev Mirrors the two TIP-20 behaviours the escrow depends on: the memo
/// variants return nothing and revert (rather than returning false) on failure,
/// and they emit TransferWithMemo alongside Transfer.
contract MockStablecoin is ERC20, ITIP20 {
    bytes32 public lastMemo;
    address public lastMemoFrom;
    address public lastMemoTo;

    constructor() ERC20("Test USD", "tUSD") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function transferWithMemo(address to, uint256 amount, bytes32 memo) external {
        _recordMemo(msg.sender, to, amount, memo);
        _transfer(msg.sender, to, amount);
    }

    function transferFromWithMemo(address from, address to, uint256 amount, bytes32 memo)
        external
    {
        _recordMemo(from, to, amount, memo);
        _spendAllowance(from, msg.sender, amount);
        _transfer(from, to, amount);
    }

    function _recordMemo(address from, address to, uint256 amount, bytes32 memo) private {
        lastMemo = memo;
        lastMemoFrom = from;
        lastMemoTo = to;
        emit TransferWithMemo(from, to, amount, memo);
    }
}

contract TempexEscrowTest is Test {
    TempexEscrow internal escrow;
    MockStablecoin internal token;

    address internal owner = makeAddr("owner");
    address internal buyer = makeAddr("buyer");
    address internal seller = makeAddr("seller");
    address internal treasury = makeAddr("treasury");
    address internal keeper = makeAddr("keeper");

    uint256 internal constant ARBITER_PK = 0xA11CE;
    address internal arbiter;

    uint16 internal constant PLATFORM_FEE_BPS = 50; // 0.5%
    uint16 internal constant ARBITRATION_FEE_BPS = 200; // 2%
    uint256 internal constant AMOUNT = 1_000e6; // 1,000 tUSD
    uint64 internal constant REVIEW_WINDOW = 1 days;

    uint64 internal deliveryDeadline;

    function setUp() public {
        arbiter = vm.addr(ARBITER_PK);
        token = new MockStablecoin();
        escrow = new TempexEscrow(
            token, owner, arbiter, treasury, PLATFORM_FEE_BPS, ARBITRATION_FEE_BPS
        );
        token.mint(buyer, 1_000_000e6);
        vm.prank(buyer);
        token.approve(address(escrow), type(uint256).max);
        deliveryDeadline = uint64(block.timestamp + 7 days);
    }

    // --------------------------------------------------------------- helpers

    function _createFundedJob() internal returns (uint256 jobId) {
        vm.prank(buyer);
        jobId =
            escrow.createJob(seller, AMOUNT, keccak256("terms:SLA-95"), deliveryDeadline, REVIEW_WINDOW);
        vm.prank(buyer);
        escrow.fund(jobId);
    }

    function _respond(uint256 jobId) internal {
        vm.prank(seller);
        escrow.respond(jobId, keccak256("seller:evidence"), 10_000);
    }

    function _verdict(uint256 jobId, uint16 sellerAwardBps, bytes32 evidenceHash)
        internal
        view
        returns (TempexEscrow.Verdict memory)
    {
        return TempexEscrow.Verdict({
            jobId: jobId,
            sellerAwardBps: sellerAwardBps,
            evidenceHash: evidenceHash,
            rationaleHash: keccak256("rationale"),
            issuedAt: uint64(block.timestamp),
            validUntil: uint64(block.timestamp + 1 hours)
        });
    }

    function _sign(uint256 pk, TempexEscrow.Verdict memory verdict)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, escrow.verdictDigest(verdict));
        return abi.encodePacked(r, s, v);
    }

    // ----------------------------------------------------------- happy paths

    function test_HappyPath_AcceptPaysSellerMinusPlatformFee() public {
        uint256 jobId = _createFundedJob();
        assertEq(token.balanceOf(address(escrow)), AMOUNT);

        vm.prank(seller);
        escrow.deliver(jobId, keccak256("deliverable:v1"), "");

        vm.prank(buyer);
        escrow.accept(jobId);

        uint256 fee = (AMOUNT * PLATFORM_FEE_BPS) / 10_000;
        assertEq(uint8(escrow.getJob(jobId).state), uint8(TempexEscrow.JobState.Settled));
        assertEq(escrow.credits(seller), AMOUNT - fee);
        assertEq(escrow.credits(treasury), fee);

        uint256 before = token.balanceOf(seller);
        vm.prank(seller);
        escrow.withdraw();
        assertEq(token.balanceOf(seller), before + AMOUNT - fee);
        assertEq(token.balanceOf(address(escrow)), fee);
    }

    function test_AutoAcceptAfterReviewWindow() public {
        uint256 jobId = _createFundedJob();
        vm.prank(seller);
        escrow.deliver(jobId, keccak256("deliverable:v1"), "");

        vm.warp(block.timestamp + REVIEW_WINDOW + 1);
        vm.prank(keeper);
        escrow.autoAccept(jobId);

        assertEq(uint8(escrow.getJob(jobId).state), uint8(TempexEscrow.JobState.Settled));
        assertEq(escrow.credits(seller), AMOUNT - (AMOUNT * PLATFORM_FEE_BPS) / 10_000);
    }

    // ------------------------------------------------------- TIP-20 memos

    function test_FundMemoCarriesJobId() public {
        uint256 jobId = _createFundedJob();

        assertEq(token.lastMemo(), bytes32(jobId), "memo must be the job id");
        assertEq(token.lastMemoFrom(), buyer);
        assertEq(token.lastMemoTo(), address(escrow));
    }

    function test_WithdrawMemoIsNamespaced() public {
        uint256 jobId = _createFundedJob();
        vm.prank(seller);
        escrow.deliver(jobId, keccak256("deliverable:v1"), "");
        vm.prank(buyer);
        escrow.accept(jobId);

        vm.prank(seller);
        escrow.withdraw();

        assertEq(token.lastMemo(), escrow.WITHDRAW_MEMO());
        assertEq(token.lastMemoTo(), seller);
    }

    function test_MemoDistinguishesSequentialJobs() public {
        uint256 first = _createFundedJob();
        uint256 second = _createFundedJob();

        assertEq(first, 1);
        assertEq(second, 2);
        assertEq(token.lastMemo(), bytes32(second), "latest fund memo tracks latest job");
    }

    function test_NextJobIdMatchesCreatedJob() public {
        assertEq(escrow.nextJobId(), 1);
        uint256 jobId = _createFundedJob();
        assertEq(jobId, 1);
        assertEq(escrow.nextJobId(), 2, "batch callers can predict the fund target");
    }

    function test_FundRevertsWhenMemoTransferFails() public {
        uint256 jobId = _createFundedJob();
        address brokeBuyer = makeAddr("brokeBuyer");

        vm.prank(brokeBuyer);
        uint256 unfunded =
            escrow.createJob(seller, AMOUNT, keccak256("terms"), deliveryDeadline, REVIEW_WINDOW);

        // no balance, no approval: the TIP-20 memo call reverts instead of returning false
        vm.prank(brokeBuyer);
        vm.expectRevert();
        escrow.fund(unfunded);

        assertEq(uint8(escrow.getJob(unfunded).state), uint8(TempexEscrow.JobState.Created));
        assertEq(uint8(escrow.getJob(jobId).state), uint8(TempexEscrow.JobState.Funded));
    }

    function test_CancelBeforeFunding() public {
        vm.prank(buyer);
        uint256 jobId =
            escrow.createJob(seller, AMOUNT, keccak256("terms"), deliveryDeadline, REVIEW_WINDOW);

        vm.prank(buyer);
        escrow.cancel(jobId);
        assertEq(uint8(escrow.getJob(jobId).state), uint8(TempexEscrow.JobState.Cancelled));

        vm.prank(buyer);
        vm.expectRevert("not open");
        escrow.fund(jobId);
    }

    function test_RefundWhenSellerMissesDeadline() public {
        uint256 jobId = _createFundedJob();

        vm.warp(deliveryDeadline + 1);
        vm.prank(keeper);
        escrow.refundExpired(jobId);

        assertEq(uint8(escrow.getJob(jobId).state), uint8(TempexEscrow.JobState.Refunded));
        assertEq(escrow.credits(buyer), AMOUNT);

        uint256 before = token.balanceOf(buyer);
        vm.prank(buyer);
        escrow.withdraw();
        assertEq(token.balanceOf(buyer), before + AMOUNT);
        assertEq(token.balanceOf(address(escrow)), 0);
    }

    // ------------------------------------------------------------- disputes

    function test_DisputeThenResolveSplitsAward() public {
        uint256 jobId = _createFundedJob();
        vm.prank(seller);
        escrow.deliver(jobId, keccak256("deliverable:partial"), "");

        vm.prank(buyer);
        escrow.dispute(jobId, keccak256("claim:only-40pct-valid"), 0);
        _respond(jobId);

        TempexEscrow.Verdict memory verdict = _verdict(jobId, 6_000, keccak256("claim:only-40pct-valid"));
        bytes memory signature = _sign(ARBITER_PK, verdict);

        vm.prank(keeper);
        escrow.resolve(jobId, verdict, signature);

        // loser pays: the seller lost 40% so bears 40% of the 20e6 fee (8e6); the
        // buyer's 12e6 share comes out of its 50e6 bond, and the remaining 38e6 of
        // bond splits 60/40 by the award
        uint256 fee = (AMOUNT * ARBITRATION_FEE_BPS) / 10_000; // 20e6
        uint256 bond = (AMOUNT * 500) / 10_000; // 50e6
        uint256 sellerAmount = 600e6 - 8e6 + 22.8e6; // 614.8e6
        uint256 buyerAmount = 400e6 + 15.2e6; // 415.2e6
        assertEq(sellerAmount + buyerAmount + fee, AMOUNT + bond);

        assertEq(uint8(escrow.getJob(jobId).state), uint8(TempexEscrow.JobState.Settled));
        assertEq(escrow.credits(seller), sellerAmount);
        assertEq(escrow.credits(buyer), buyerAmount);
        assertEq(escrow.credits(treasury), fee);
        assertEq(escrow.getJob(jobId).verdictHash, escrow.verdictDigest(verdict));

        vm.prank(buyer);
        escrow.withdraw();
        assertEq(token.balanceOf(buyer), 1_000_000e6 - AMOUNT - bond + buyerAmount);
    }

    function test_ResolveWithZeroAwardRefundsBuyer() public {
        uint256 jobId = _createFundedJob();
        vm.prank(seller);
        escrow.deliver(jobId, keccak256("deliverable:junk"), "");
        vm.prank(buyer);
        escrow.dispute(jobId, keccak256("claim:junk"), 0);
        _respond(jobId);

        TempexEscrow.Verdict memory verdict = _verdict(jobId, 0, keccak256("claim:junk"));
        vm.prank(keeper);
        escrow.resolve(jobId, verdict, _sign(ARBITER_PK, verdict));

        // the seller won nothing, so it cannot pay its share of the fee: the buyer
        // covers it, and gets its whole bond back
        uint256 fee = (AMOUNT * ARBITRATION_FEE_BPS) / 10_000;
        assertEq(escrow.credits(seller), 0);
        assertEq(escrow.credits(buyer), AMOUNT - fee + escrow.disputeBond(jobId));
    }

    function test_ResolveRevertsForNonArbiterSignature() public {
        uint256 jobId = _createFundedJob();
        vm.prank(seller);
        escrow.deliver(jobId, keccak256("d"), "");
        vm.prank(buyer);
        escrow.dispute(jobId, keccak256("c"), 0);
        _respond(jobId);

        TempexEscrow.Verdict memory verdict = _verdict(jobId, 6_000, keccak256("c"));
        bytes memory forged = _sign(0xB0B, verdict); // not the arbiter

        vm.expectRevert("bad verdict signature");
        escrow.resolve(jobId, verdict, forged);
    }

    function test_ResolveRevertsOnTamperedVerdict() public {
        uint256 jobId = _createFundedJob();
        vm.prank(seller);
        escrow.deliver(jobId, keccak256("d"), "");
        vm.prank(buyer);
        escrow.dispute(jobId, keccak256("c"), 0);
        _respond(jobId);

        TempexEscrow.Verdict memory signed = _verdict(jobId, 6_000, keccak256("c"));
        bytes memory signature = _sign(ARBITER_PK, signed);

        TempexEscrow.Verdict memory tampered = signed;
        tampered.sellerAwardBps = 9_500; // edited after signing

        vm.expectRevert("bad verdict signature");
        escrow.resolve(jobId, tampered, signature);
    }

    function test_ResolveRevertsWhenVerdictExpiredOrPremature() public {
        uint256 jobId = _createFundedJob();
        vm.prank(seller);
        escrow.deliver(jobId, keccak256("d"), "");
        vm.prank(buyer);
        escrow.dispute(jobId, keccak256("c"), 0);
        _respond(jobId);

        TempexEscrow.Verdict memory expired = _verdict(jobId, 6_000, keccak256("c"));
        expired.validUntil = uint64(block.timestamp - 1);
        bytes memory expiredSig = _sign(ARBITER_PK, expired);
        vm.expectRevert("verdict expired");
        escrow.resolve(jobId, expired, expiredSig);

        TempexEscrow.Verdict memory premature = _verdict(jobId, 6_000, keccak256("c"));
        premature.issuedAt = uint64(block.timestamp + 1 hours);
        premature.validUntil = uint64(block.timestamp + 2 hours);
        bytes memory prematureSig = _sign(ARBITER_PK, premature);
        vm.expectRevert("verdict not yet valid");
        escrow.resolve(jobId, premature, prematureSig);
    }

    function test_ResolveRevertsOnAwardBpsTooHigh() public {
        uint256 jobId = _createFundedJob();
        vm.prank(seller);
        escrow.deliver(jobId, keccak256("d"), "");
        vm.prank(buyer);
        escrow.dispute(jobId, keccak256("c"), 0);
        _respond(jobId);

        TempexEscrow.Verdict memory verdict = _verdict(jobId, 10_001, keccak256("c"));
        bytes memory signature = _sign(ARBITER_PK, verdict);
        vm.expectRevert("awardBps>10000");
        escrow.resolve(jobId, verdict, signature);
    }

    function test_ResolveCannotRunTwice() public {
        uint256 jobId = _createFundedJob();
        vm.prank(seller);
        escrow.deliver(jobId, keccak256("d"), "");
        vm.prank(buyer);
        escrow.dispute(jobId, keccak256("c"), 0);
        _respond(jobId);

        TempexEscrow.Verdict memory verdict = _verdict(jobId, 6_000, keccak256("c"));
        bytes memory signature = _sign(ARBITER_PK, verdict);
        escrow.resolve(jobId, verdict, signature);

        vm.expectRevert("not disputed");
        escrow.resolve(jobId, verdict, signature);
    }

    function test_ResolveDigestIsBoundToChainAndContract() public {
        uint256 jobId = _createFundedJob();
        TempexEscrow.Verdict memory verdict = _verdict(jobId, 6_000, keccak256("c"));

        bytes32 digestHere = escrow.verdictDigest(verdict);

        // Same escrow, different chain id => different digest
        uint256 snapshot = vm.snapshotState();
        vm.chainId(42431);
        bytes32 digestOtherChain = escrow.verdictDigest(verdict);
        vm.revertToState(snapshot);
        assertTrue(digestHere != digestOtherChain);

        // Same chain, different escrow => different digest
        TempexEscrow other = new TempexEscrow(
            token, owner, arbiter, treasury, PLATFORM_FEE_BPS, ARBITRATION_FEE_BPS
        );
        assertTrue(digestHere != other.verdictDigest(verdict));
    }

    // ------------------------------------------------- seller response window

    function _deliveredAndDisputed() internal returns (uint256 jobId) {
        jobId = _createFundedJob();
        vm.prank(seller);
        escrow.deliver(jobId, keccak256("d"), "");
        vm.prank(buyer);
        escrow.dispute(jobId, keccak256("c"), 0);
    }

    function test_DisputeNotifiesSellerWithSevenDayDeadline() public {
        uint256 jobId = _createFundedJob();
        vm.prank(seller);
        escrow.deliver(jobId, keccak256("d"), "");

        vm.expectEmit(true, true, false, true, address(escrow));
        emit TempexEscrow.SellerResponseRequested(jobId, seller, uint64(block.timestamp + 7 days));
        vm.prank(buyer);
        escrow.dispute(jobId, keccak256("c"), 0);

        TempexEscrow.Job memory job = escrow.getJob(jobId);
        assertEq(job.disputedAt, block.timestamp);
        assertEq(escrow.SELLER_RESPONSE_WINDOW(), 7 days);
        assertEq(escrow.evidenceClosedAt(jobId), 0, "window open, no response yet");
    }

    function test_ResolveBlockedWhileSellerWindowOpen() public {
        uint256 jobId = _deliveredAndDisputed();
        TempexEscrow.Verdict memory verdict = _verdict(jobId, 0, keccak256("c"));
        verdict.validUntil = uint64(block.timestamp + 30 days);
        bytes memory signature = _sign(ARBITER_PK, verdict);

        vm.expectRevert("seller response window open");
        escrow.resolve(jobId, verdict, signature);

        vm.warp(block.timestamp + 7 days); // last second of the window
        vm.expectRevert("seller response window open");
        escrow.resolve(jobId, verdict, signature);
    }

    function test_SellerRespondsThenArbiterRules() public {
        uint256 jobId = _deliveredAndDisputed();
        vm.warp(block.timestamp + 2 days);

        vm.expectEmit(true, false, false, true, address(escrow));
        emit TempexEscrow.SellerResponded(jobId, keccak256("proof"), 10_000, uint64(block.timestamp));
        vm.prank(seller);
        escrow.respond(jobId, keccak256("proof"), 10_000);

        TempexEscrow.Job memory job = escrow.getJob(jobId);
        assertEq(job.responseHash, keccak256("proof"));
        assertEq(job.respondedAt, block.timestamp);
        assertEq(escrow.evidenceClosedAt(jobId), block.timestamp);

        TempexEscrow.Verdict memory verdict = _verdict(jobId, 8_000, keccak256("c"));
        escrow.resolve(jobId, verdict, _sign(ARBITER_PK, verdict));
        assertEq(uint8(escrow.getJob(jobId).state), uint8(TempexEscrow.JobState.Settled));
    }

    function test_SilentSellerLetsArbiterRuleAfterWindow() public {
        uint256 jobId = _deliveredAndDisputed();
        uint64 deadline = uint64(block.timestamp + 7 days);
        vm.warp(deadline + 1);
        assertEq(escrow.evidenceClosedAt(jobId), deadline);

        vm.prank(seller);
        vm.expectRevert("response window closed");
        escrow.respond(jobId, keccak256("too late"), 10_000);

        TempexEscrow.Verdict memory verdict = _verdict(jobId, 0, keccak256("c"));
        escrow.resolve(jobId, verdict, _sign(ARBITER_PK, verdict));
        assertEq(
            escrow.credits(buyer),
            AMOUNT - (AMOUNT * ARBITRATION_FEE_BPS) / 10_000 + escrow.disputeBond(jobId)
        );
    }

    function test_VerdictSignedBeforeSellerEvidenceIsRejected() public {
        uint256 jobId = _deliveredAndDisputed();
        // arbiter pre-signs a ruling before the seller has been heard
        TempexEscrow.Verdict memory early = _verdict(jobId, 0, keccak256("c"));
        early.validUntil = uint64(block.timestamp + 30 days);
        bytes memory earlySig = _sign(ARBITER_PK, early);

        vm.warp(block.timestamp + 1 days);
        vm.prank(seller);
        escrow.respond(jobId, keccak256("proof"), 10_000);

        vm.expectRevert("verdict predates seller evidence");
        escrow.resolve(jobId, early, earlySig);
    }

    function test_RespondGuards() public {
        uint256 jobId = _createFundedJob();
        vm.prank(seller);
        escrow.deliver(jobId, keccak256("d"), "");

        vm.prank(seller);
        vm.expectRevert("not disputed");
        escrow.respond(jobId, keccak256("proof"), 10_000);

        vm.prank(buyer);
        escrow.dispute(jobId, keccak256("c"), 0);

        vm.prank(buyer);
        vm.expectRevert("only seller");
        escrow.respond(jobId, keccak256("proof"), 10_000);

        vm.prank(seller);
        vm.expectRevert("responseHash=0");
        escrow.respond(jobId, bytes32(0), 10_000);

        vm.prank(seller);
        escrow.respond(jobId, keccak256("proof"), 10_000);
        vm.prank(seller);
        vm.expectRevert("already responded");
        escrow.respond(jobId, keccak256("proof v2"), 10_000);
    }

    // ------------------------------------------------- bond and loser pays

    function test_DisputePullsBondWithJobMemo() public {
        uint256 jobId = _createFundedJob();
        vm.prank(seller);
        escrow.deliver(jobId, keccak256("d"), "");
        uint256 before = token.balanceOf(buyer);

        vm.prank(buyer);
        escrow.dispute(jobId, keccak256("c"), 0);

        assertEq(escrow.disputeBond(jobId), AMOUNT / 20);
        assertEq(token.balanceOf(buyer), before - AMOUNT / 20);
        assertEq(token.lastMemo(), bytes32(jobId));
        assertEq(token.balanceOf(address(escrow)), AMOUNT + AMOUNT / 20);
    }

    function test_DisputeRevertsWithoutBondAllowance() public {
        uint256 jobId = _createFundedJob();
        vm.prank(seller);
        escrow.deliver(jobId, keccak256("d"), "");
        vm.prank(buyer);
        token.approve(address(escrow), 0);

        vm.prank(buyer);
        vm.expectRevert();
        escrow.dispute(jobId, keccak256("c"), 0);
        assertEq(uint8(escrow.getJob(jobId).state), uint8(TempexEscrow.JobState.Delivered));
    }

    function test_BuyerWhoLosesPaysFeeAndForfeitsBond() public {
        uint256 jobId = _deliveredAndDisputed();
        _respond(jobId);
        TempexEscrow.Verdict memory v = _verdict(jobId, 10_000, keccak256("c"));
        escrow.resolve(jobId, v, _sign(ARBITER_PK, v));

        // the seller keeps the full amount; the buyer's bond pays the whole fee and
        // the rest of it is forfeited to the seller
        uint256 fee = (AMOUNT * ARBITRATION_FEE_BPS) / 10_000;
        assertEq(escrow.credits(seller), AMOUNT + AMOUNT / 20 - fee);
        assertEq(escrow.credits(buyer), 0);
        assertEq(escrow.credits(treasury), (AMOUNT * ARBITRATION_FEE_BPS) / 10_000);
    }

    function test_EveryDisputeSettlementIsSolvent() public {
        uint16[5] memory awards = [uint16(0), 1, 3_250, 9_999, 10_000];
        for (uint256 i = 0; i < awards.length; i++) {
            uint256 jobId = _deliveredAndDisputed();
            _respond(jobId);
            TempexEscrow.Verdict memory v = _verdict(jobId, awards[i], keccak256("c"));
            escrow.resolve(jobId, v, _sign(ARBITER_PK, v));
        }
        uint256 owed = escrow.credits(seller) + escrow.credits(buyer) + escrow.credits(treasury)
            + escrow.credits(arbiter);
        assertEq(owed, token.balanceOf(address(escrow)), "credits equal exactly what the escrow holds");
    }

    function testFuzz_DisputeSettlementConservesMoney(uint256 amount, uint16 feeBps, uint16 awardBps)
        public
        view
    {
        amount = bound(amount, 1, 1e30);
        feeBps = uint16(bound(feeBps, 0, 1_000));
        awardBps = uint16(bound(awardBps, 0, 10_000));
        uint256 fee = (amount * feeBps) / 10_000;
        uint256 bond = (amount * 500) / 10_000;
        (uint256 sellerAmount, uint256 buyerAmount, uint256 bondToSeller) =
            escrow.disputeSettlement(amount, bond, fee, awardBps);
        assertEq(sellerAmount + buyerAmount + fee, amount + bond, "nothing created or lost");
        assertLe(bondToSeller, bond);
        // a seller never receives more than its award plus the forfeited bond
        assertLe(sellerAmount, (amount * awardBps) / 10_000 + bondToSeller);
    }

    // ------------------------------------------------------ deliverable URI

    function test_DeliveryRecordsWhereTheWorkLives() public {
        uint256 jobId = _createFundedJob();
        vm.expectEmit(true, false, false, true, address(escrow));
        emit TempexEscrow.DeliverableLocated(jobId, "ipfs://bafybeigdyrzt5example");
        vm.prank(seller);
        escrow.deliver(jobId, keccak256("work"), "ipfs://bafybeigdyrzt5example");
        assertEq(escrow.deliverableURI(jobId), "ipfs://bafybeigdyrzt5example");
    }

    function test_EmptyUriRecordsNothing() public {
        uint256 jobId = _createFundedJob();
        vm.recordLogs();
        vm.prank(seller);
        escrow.deliver(jobId, keccak256("work"), "");
        assertEq(bytes(escrow.deliverableURI(jobId)).length, 0);
        assertEq(vm.getRecordedLogs().length, 1, "only JobDelivered");
    }

    function test_OverlongUriIsRejected() public {
        uint256 jobId = _createFundedJob();
        vm.prank(seller);
        vm.expectRevert("uri too long");
        escrow.deliver(jobId, keccak256("work"), string(new bytes(2_049)));
    }

    // ---------------------------------------------------- final-offer bounds

    function _offers(uint16 buyerOffer, uint16 sellerAsk) internal returns (uint256 jobId) {
        jobId = _createFundedJob();
        vm.prank(seller);
        escrow.deliver(jobId, keccak256("d"), "");
        vm.prank(buyer);
        escrow.dispute(jobId, keccak256("c"), buyerOffer);
        vm.prank(seller);
        escrow.respond(jobId, keccak256("proof"), sellerAsk);
    }

    function test_AwardMustFallBetweenTheOffers() public {
        uint256 jobId = _offers(2_500, 6_000);
        (uint16 low, uint16 high) = escrow.awardBounds(jobId);
        assertEq(low, 2_500);
        assertEq(high, 6_000);

        TempexEscrow.Verdict memory tooLow = _verdict(jobId, 2_499, keccak256("c"));
        bytes memory tooLowSig = _sign(ARBITER_PK, tooLow);
        vm.expectRevert("award outside the parties' offers");
        escrow.resolve(jobId, tooLow, tooLowSig);

        TempexEscrow.Verdict memory tooHigh = _verdict(jobId, 6_001, keccak256("c"));
        bytes memory tooHighSig = _sign(ARBITER_PK, tooHigh);
        vm.expectRevert("award outside the parties' offers");
        escrow.resolve(jobId, tooHigh, tooHighSig);

        TempexEscrow.Verdict memory edge = _verdict(jobId, 6_000, keccak256("c"));
        escrow.resolve(jobId, edge, _sign(ARBITER_PK, edge));
    }

    function test_OverlappingOffersStillBound() public {
        // the seller asks for less than the buyer offers: any award between agrees with both
        uint256 jobId = _offers(7_000, 4_000);
        (uint16 low, uint16 high) = escrow.awardBounds(jobId);
        assertEq(low, 4_000);
        assertEq(high, 7_000);
    }

    function test_SilentSellerAsksForEverything() public {
        uint256 jobId = _createFundedJob();
        vm.prank(seller);
        escrow.deliver(jobId, keccak256("d"), "");
        vm.prank(buyer);
        escrow.dispute(jobId, keccak256("c"), 3_000);
        (uint16 low, uint16 high) = escrow.awardBounds(jobId);
        assertEq(low, 3_000);
        assertEq(high, 10_000);
        assertEq(escrow.getJob(jobId).buyerOfferBps, 3_000);
    }

    function test_LapsedDisputeSettlesAtMidpointOfOffers() public {
        uint256 jobId = _offers(2_000, 6_000);
        vm.warp(escrow.evidenceClosedAt(jobId) + 7 days + 1);
        escrow.settleLapsed(jobId);
        assertEq(escrow.credits(seller), (AMOUNT * 4_000) / 10_000);
        assertEq(escrow.credits(buyer), (AMOUNT * 6_000) / 10_000 + escrow.disputeBond(jobId));
    }

    function test_OffersAreBoundedBps() public {
        uint256 jobId = _createFundedJob();
        vm.prank(seller);
        escrow.deliver(jobId, keccak256("d"), "");
        vm.prank(buyer);
        vm.expectRevert("offer>10000");
        escrow.dispute(jobId, keccak256("c"), 10_001);
        vm.prank(buyer);
        escrow.dispute(jobId, keccak256("c"), 0);
        vm.prank(seller);
        vm.expectRevert("ask>10000");
        escrow.respond(jobId, keccak256("proof"), 10_001);
    }

    // ------------------------------------------- per-job arbiter and fees

    function test_JobLocksArbiterAndFeesAtCreation() public {
        uint256 jobId = _createFundedJob();
        TempexEscrow.Job memory job = escrow.getJob(jobId);
        assertEq(job.arbiter, arbiter);
        assertEq(job.platformFeeBps, PLATFORM_FEE_BPS);
        assertEq(job.arbitrationFeeBps, ARBITRATION_FEE_BPS);
    }

    function test_ArbiterSwapDoesNotReachOpenDispute() public {
        uint256 jobId = _deliveredAndDisputed();
        _respond(jobId);

        uint256 ownerKey = 0xB0B;
        vm.prank(owner);
        escrow.setArbiter(vm.addr(ownerKey));

        TempexEscrow.Verdict memory v = _verdict(jobId, 0, keccak256("c"));
        bytes memory ownerSig = _sign(ownerKey, v);
        vm.expectRevert("bad verdict signature");
        escrow.resolve(jobId, v, ownerSig);

        // the job's own arbiter still rules it
        escrow.resolve(jobId, v, _sign(ARBITER_PK, v));

        // and only jobs created after the swap use the new arbiter
        uint256 next = _createFundedJob();
        assertEq(escrow.getJob(next).arbiter, vm.addr(ownerKey));
    }

    function test_FeeChangeDoesNotReachOpenJobs() public {
        uint256 disputed = _deliveredAndDisputed();
        _respond(disputed);
        uint256 delivered = _createFundedJob();
        vm.prank(seller);
        escrow.deliver(delivered, keccak256("d"), "");

        vm.prank(owner);
        escrow.setFees(500, 1_000);

        TempexEscrow.Verdict memory v = _verdict(disputed, 10_000, keccak256("c"));
        escrow.resolve(disputed, v, _sign(ARBITER_PK, v));
        assertEq(escrow.credits(treasury), (AMOUNT * ARBITRATION_FEE_BPS) / 10_000);

        vm.prank(buyer);
        escrow.accept(delivered);
        assertEq(
            escrow.credits(treasury),
            (AMOUNT * ARBITRATION_FEE_BPS) / 10_000 + (AMOUNT * PLATFORM_FEE_BPS) / 10_000
        );
    }

    function test_VerdictMustCiteThePinnedDispute() public {
        uint256 jobId = _deliveredAndDisputed();
        _respond(jobId);
        TempexEscrow.Verdict memory v = _verdict(jobId, 0, keccak256("some other bundle"));
        bytes memory signature = _sign(ARBITER_PK, v);
        vm.expectRevert("evidence is not the pinned dispute");
        escrow.resolve(jobId, v, signature);
    }

    // ------------------------------------------------------ arbiter market

    uint256 internal constant MARKET_ARBITER_PK = 0xC0DE;

    function _marketJob(uint16 feeBps) internal returns (uint256 jobId, address judge) {
        judge = vm.addr(MARKET_ARBITER_PK);
        vm.prank(judge);
        escrow.listArbiter(feeBps, "ipfs://judge-profile");
        vm.prank(buyer);
        jobId = escrow.createJobWithArbiter(
            seller, AMOUNT, keccak256("t"), deliveryDeadline, REVIEW_WINDOW, judge
        );
        vm.prank(buyer);
        escrow.fund(jobId);
        vm.prank(seller);
        escrow.deliver(jobId, keccak256("d"), "");
        vm.prank(buyer);
        escrow.dispute(jobId, keccak256("c"), 0);
        _respond(jobId);
    }

    function test_BuyerChoosesListedArbiterWhoEarnsItsFee() public {
        (uint256 jobId, address judge) = _marketJob(300);
        TempexEscrow.Job memory job = escrow.getJob(jobId);
        assertEq(job.arbiter, judge);
        assertEq(job.arbitrationFeeBps, 300);
        assertEq(job.protocolCutBps, 2_000);

        TempexEscrow.Verdict memory v = _verdict(jobId, 5_000, keccak256("c"));
        bytes memory houseSig = _sign(ARBITER_PK, v);
        vm.expectRevert("bad verdict signature");
        escrow.resolve(jobId, v, houseSig); // the house arbiter cannot rule a market job

        escrow.resolve(jobId, v, _sign(MARKET_ARBITER_PK, v));
        uint256 fee = (AMOUNT * 300) / 10_000; // 30e6
        assertEq(escrow.credits(treasury), (fee * 2_000) / 10_000); // 6e6
        assertEq(escrow.credits(judge), fee - (fee * 2_000) / 10_000); // 24e6
    }

    function test_HouseJobFeeGoesWhollyToTreasury() public {
        uint256 jobId = _deliveredAndDisputed();
        _respond(jobId);
        TempexEscrow.Verdict memory v = _verdict(jobId, 5_000, keccak256("c"));
        escrow.resolve(jobId, v, _sign(ARBITER_PK, v));
        assertEq(escrow.credits(treasury), (AMOUNT * ARBITRATION_FEE_BPS) / 10_000);
        assertEq(escrow.credits(arbiter), 0);
    }

    function test_ArbiterRepricingAndDelistingSpareOpenJobs() public {
        (uint256 jobId, address judge) = _marketJob(300);
        vm.prank(judge);
        escrow.listArbiter(1_000, "ipfs://judge-profile"); // raises its fee
        vm.prank(judge);
        escrow.delistArbiter();
        vm.prank(owner);
        escrow.setProtocolCut(5_000);

        TempexEscrow.Verdict memory v = _verdict(jobId, 5_000, keccak256("c"));
        escrow.resolve(jobId, v, _sign(MARKET_ARBITER_PK, v));
        uint256 fee = (AMOUNT * 300) / 10_000;
        assertEq(escrow.credits(judge), fee - (fee * 2_000) / 10_000, "locked fee and cut hold");

        vm.prank(buyer);
        vm.expectRevert("arbiter not listed");
        escrow.createJobWithArbiter(seller, AMOUNT, keccak256("t"), deliveryDeadline, REVIEW_WINDOW, judge);
    }

    function test_ArbiterListingGuards() public {
        vm.prank(seller);
        vm.expectRevert("arbitrationFee too high");
        escrow.listArbiter(1_001, "");

        vm.prank(seller);
        escrow.listArbiter(100, "");
        vm.prank(buyer);
        vm.expectRevert("party cannot judge");
        escrow.createJobWithArbiter(seller, AMOUNT, keccak256("t"), deliveryDeadline, REVIEW_WINDOW, seller);

        vm.prank(buyer);
        vm.expectRevert("arbiter not listed");
        escrow.createJobWithArbiter(seller, AMOUNT, keccak256("t"), deliveryDeadline, REVIEW_WINDOW, keeper);

        vm.prank(buyer);
        vm.expectRevert();
        escrow.setProtocolCut(0);
        vm.prank(owner);
        vm.expectRevert("protocolCut too high");
        escrow.setProtocolCut(5_001);
    }

    // ------------------------------------------------------- lapsed disputes

    function test_SilentArbiterLetsAnyoneSettleEvenSplit() public {
        uint256 jobId = _deliveredAndDisputed();
        _respond(jobId);
        uint64 closedAt = escrow.evidenceClosedAt(jobId);

        vm.warp(closedAt + 7 days);
        vm.expectRevert("arbitration window open");
        escrow.settleLapsed(jobId);

        vm.warp(closedAt + 7 days + 1);
        vm.prank(keeper);
        escrow.settleLapsed(jobId);

        assertEq(uint8(escrow.getJob(jobId).state), uint8(TempexEscrow.JobState.Settled));
        assertEq(escrow.credits(seller), AMOUNT / 2);
        assertEq(escrow.credits(buyer), AMOUNT / 2 + escrow.disputeBond(jobId), "bond comes back");
        assertEq(escrow.credits(treasury), 0, "an arbiter that never ruled earns nothing");
    }

    function test_LateVerdictCannotOverrideLapse() public {
        uint256 jobId = _deliveredAndDisputed();
        _respond(jobId);
        uint64 closedAt = escrow.evidenceClosedAt(jobId);

        TempexEscrow.Verdict memory v = _verdict(jobId, 10_000, keccak256("c"));
        v.validUntil = uint64(closedAt + 30 days);
        bytes memory signature = _sign(ARBITER_PK, v);

        vm.warp(closedAt + 7 days + 1);
        vm.expectRevert("arbitration window lapsed");
        escrow.resolve(jobId, v, signature);
    }

    function test_SilentSellerAndSilentArbiterStillUnlock() public {
        uint256 jobId = _deliveredAndDisputed();
        vm.warp(block.timestamp + 14 days + 1);
        escrow.settleLapsed(jobId);
        assertEq(escrow.credits(buyer), AMOUNT / 2 + escrow.disputeBond(jobId));
    }

    // --------------------------------------------------------------- limits

    function test_ReviewWindowIsCapped() public {
        vm.prank(buyer);
        vm.expectRevert("reviewWindow too long");
        escrow.createJob(seller, AMOUNT, keccak256("t"), deliveryDeadline, 30 days + 1);
    }

    function test_OwnershipTransferNeedsAcceptance() public {
        address next = makeAddr("next");
        vm.prank(owner);
        escrow.transferOwnership(next);
        assertEq(escrow.owner(), owner, "a typo cannot hand the contract away");

        vm.prank(next);
        escrow.acceptOwnership();
        assertEq(escrow.owner(), next);
    }

    // --------------------------------------------------------- state guards

    function test_DisputeOnlyByBuyerInsideWindow() public {
        uint256 jobId = _createFundedJob();
        vm.prank(seller);
        escrow.deliver(jobId, keccak256("d"), "");

        vm.prank(seller);
        vm.expectRevert("only buyer");
        escrow.dispute(jobId, keccak256("c"), 0);

        vm.warp(block.timestamp + REVIEW_WINDOW + 1);
        vm.prank(buyer);
        vm.expectRevert("review window closed");
        escrow.dispute(jobId, keccak256("c"), 0);
    }

    function test_DeliverRejectedAfterDeadline() public {
        uint256 jobId = _createFundedJob();
        vm.warp(deliveryDeadline + 1);
        vm.prank(seller);
        vm.expectRevert("delivery deadline passed");
        escrow.deliver(jobId, keccak256("late"), "");
    }

    function test_RefundUnavailableBeforeDeadline() public {
        uint256 jobId = _createFundedJob();
        vm.expectRevert("deadline not passed");
        escrow.refundExpired(jobId);
    }

    function test_FundOnlyByBuyerAndBeforeDeadline() public {
        vm.prank(buyer);
        uint256 jobId =
            escrow.createJob(seller, AMOUNT, keccak256("t"), deliveryDeadline, REVIEW_WINDOW);

        vm.prank(seller);
        vm.expectRevert("only buyer");
        escrow.fund(jobId);

        vm.warp(deliveryDeadline + 1);
        vm.prank(buyer);
        vm.expectRevert("deadline passed");
        escrow.fund(jobId);
    }

    function test_CreateJobRejectsSelfDealingAndZeroAmount() public {
        vm.prank(buyer);
        vm.expectRevert("invalid seller");
        escrow.createJob(buyer, AMOUNT, keccak256("t"), deliveryDeadline, REVIEW_WINDOW);

        vm.prank(buyer);
        vm.expectRevert("amount=0");
        escrow.createJob(seller, 0, keccak256("t"), deliveryDeadline, REVIEW_WINDOW);
    }

    function test_WithdrawRevertsWithoutCredit() public {
        vm.prank(seller);
        vm.expectRevert("nothing to withdraw");
        escrow.withdraw();
    }

    function test_SetFeesHonorsCaps() public {
        vm.prank(owner);
        vm.expectRevert("platformFee too high");
        escrow.setFees(501, 200);

        vm.prank(owner);
        vm.expectRevert("arbitrationFee too high");
        escrow.setFees(50, 1_001);

        vm.prank(owner);
        escrow.setFees(100, 300);
        assertEq(escrow.platformFeeBps(), 100);
        assertEq(escrow.arbitrationFeeBps(), 300);
    }

    function test_AdminFunctionsAreOwnerOnly() public {
        vm.prank(buyer);
        vm.expectRevert();
        escrow.setArbiter(buyer);

        vm.prank(buyer);
        vm.expectRevert();
        escrow.setTreasury(buyer);

        vm.prank(buyer);
        vm.expectRevert();
        escrow.setFees(0, 0);
    }
}
