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
        escrow.deliver(jobId, keccak256("deliverable:v1"));

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
        escrow.deliver(jobId, keccak256("deliverable:v1"));

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
        escrow.deliver(jobId, keccak256("deliverable:v1"));
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
        escrow.deliver(jobId, keccak256("deliverable:partial"));

        vm.prank(buyer);
        escrow.dispute(jobId, keccak256("claim:only-40pct-valid"));

        TempexEscrow.Verdict memory verdict = _verdict(jobId, 6_000, keccak256("evidence:bundle"));
        bytes memory signature = _sign(ARBITER_PK, verdict);

        vm.prank(keeper);
        escrow.resolve(jobId, verdict, signature);

        uint256 fee = (AMOUNT * ARBITRATION_FEE_BPS) / 10_000; // 20e6
        uint256 remaining = AMOUNT - fee; // 980e6
        uint256 sellerAmount = (remaining * 6_000) / 10_000; // 588e6
        uint256 buyerAmount = remaining - sellerAmount; // 392e6

        assertEq(uint8(escrow.getJob(jobId).state), uint8(TempexEscrow.JobState.Settled));
        assertEq(escrow.credits(seller), sellerAmount);
        assertEq(escrow.credits(buyer), buyerAmount);
        assertEq(escrow.credits(treasury), fee);
        assertEq(escrow.getJob(jobId).verdictHash, escrow.verdictDigest(verdict));

        vm.prank(buyer);
        escrow.withdraw();
        assertEq(token.balanceOf(buyer), 1_000_000e6 - AMOUNT + buyerAmount);
    }

    function test_ResolveWithZeroAwardRefundsBuyer() public {
        uint256 jobId = _createFundedJob();
        vm.prank(seller);
        escrow.deliver(jobId, keccak256("deliverable:junk"));
        vm.prank(buyer);
        escrow.dispute(jobId, keccak256("claim:junk"));

        TempexEscrow.Verdict memory verdict = _verdict(jobId, 0, keccak256("evidence"));
        vm.prank(keeper);
        escrow.resolve(jobId, verdict, _sign(ARBITER_PK, verdict));

        uint256 fee = (AMOUNT * ARBITRATION_FEE_BPS) / 10_000;
        assertEq(escrow.credits(seller), 0);
        assertEq(escrow.credits(buyer), AMOUNT - fee);
    }

    function test_ResolveRevertsForNonArbiterSignature() public {
        uint256 jobId = _createFundedJob();
        vm.prank(seller);
        escrow.deliver(jobId, keccak256("d"));
        vm.prank(buyer);
        escrow.dispute(jobId, keccak256("c"));

        TempexEscrow.Verdict memory verdict = _verdict(jobId, 6_000, keccak256("e"));
        bytes memory forged = _sign(0xB0B, verdict); // not the arbiter

        vm.expectRevert("bad verdict signature");
        escrow.resolve(jobId, verdict, forged);
    }

    function test_ResolveRevertsOnTamperedVerdict() public {
        uint256 jobId = _createFundedJob();
        vm.prank(seller);
        escrow.deliver(jobId, keccak256("d"));
        vm.prank(buyer);
        escrow.dispute(jobId, keccak256("c"));

        TempexEscrow.Verdict memory signed = _verdict(jobId, 6_000, keccak256("e"));
        bytes memory signature = _sign(ARBITER_PK, signed);

        TempexEscrow.Verdict memory tampered = signed;
        tampered.sellerAwardBps = 9_500; // edited after signing

        vm.expectRevert("bad verdict signature");
        escrow.resolve(jobId, tampered, signature);
    }

    function test_ResolveRevertsWhenVerdictExpiredOrPremature() public {
        uint256 jobId = _createFundedJob();
        vm.prank(seller);
        escrow.deliver(jobId, keccak256("d"));
        vm.prank(buyer);
        escrow.dispute(jobId, keccak256("c"));

        TempexEscrow.Verdict memory expired = _verdict(jobId, 6_000, keccak256("e"));
        expired.validUntil = uint64(block.timestamp - 1);
        bytes memory expiredSig = _sign(ARBITER_PK, expired);
        vm.expectRevert("verdict expired");
        escrow.resolve(jobId, expired, expiredSig);

        TempexEscrow.Verdict memory premature = _verdict(jobId, 6_000, keccak256("e"));
        premature.issuedAt = uint64(block.timestamp + 1 hours);
        premature.validUntil = uint64(block.timestamp + 2 hours);
        bytes memory prematureSig = _sign(ARBITER_PK, premature);
        vm.expectRevert("verdict not yet valid");
        escrow.resolve(jobId, premature, prematureSig);
    }

    function test_ResolveRevertsOnAwardBpsTooHigh() public {
        uint256 jobId = _createFundedJob();
        vm.prank(seller);
        escrow.deliver(jobId, keccak256("d"));
        vm.prank(buyer);
        escrow.dispute(jobId, keccak256("c"));

        TempexEscrow.Verdict memory verdict = _verdict(jobId, 10_001, keccak256("e"));
        bytes memory signature = _sign(ARBITER_PK, verdict);
        vm.expectRevert("awardBps>10000");
        escrow.resolve(jobId, verdict, signature);
    }

    function test_ResolveCannotRunTwice() public {
        uint256 jobId = _createFundedJob();
        vm.prank(seller);
        escrow.deliver(jobId, keccak256("d"));
        vm.prank(buyer);
        escrow.dispute(jobId, keccak256("c"));

        TempexEscrow.Verdict memory verdict = _verdict(jobId, 6_000, keccak256("e"));
        bytes memory signature = _sign(ARBITER_PK, verdict);
        escrow.resolve(jobId, verdict, signature);

        vm.expectRevert("not disputed");
        escrow.resolve(jobId, verdict, signature);
    }

    function test_ResolveDigestIsBoundToChainAndContract() public {
        uint256 jobId = _createFundedJob();
        TempexEscrow.Verdict memory verdict = _verdict(jobId, 6_000, keccak256("e"));

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

    // --------------------------------------------------------- state guards

    function test_DisputeOnlyByBuyerInsideWindow() public {
        uint256 jobId = _createFundedJob();
        vm.prank(seller);
        escrow.deliver(jobId, keccak256("d"));

        vm.prank(seller);
        vm.expectRevert("only buyer");
        escrow.dispute(jobId, keccak256("c"));

        vm.warp(block.timestamp + REVIEW_WINDOW + 1);
        vm.prank(buyer);
        vm.expectRevert("review window closed");
        escrow.dispute(jobId, keccak256("c"));
    }

    function test_DeliverRejectedAfterDeadline() public {
        uint256 jobId = _createFundedJob();
        vm.warp(deliveryDeadline + 1);
        vm.prank(seller);
        vm.expectRevert("delivery deadline passed");
        escrow.deliver(jobId, keccak256("late"));
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
