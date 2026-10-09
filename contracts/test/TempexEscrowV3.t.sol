// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

import {ITIP20} from "../src/ITIP20.sol";
import {TempexEscrow} from "../src/TempexEscrow.sol";
import {TempexDeployment} from "../script/TempexDeployment.sol";
import {MockStablecoin} from "./TempexEscrow.t.sol";

/// A later implementation, for exercising the upgrade path.
contract TempexEscrowNext is TempexEscrow {
    function version() external pure override returns (string memory) {
        return "3.1.0-test";
    }
}

/// v3: the proxy and its upgrade key, the launch guards (pause, caps, fee floor)
/// and the referral share.
contract TempexEscrowV3Test is Test {
    TempexEscrow internal escrow;
    address internal implementation;
    MockStablecoin internal token;

    address internal owner = makeAddr("owner");
    address internal buyer = makeAddr("buyer");
    address internal seller = makeAddr("seller");
    address internal treasury = makeAddr("treasury");
    address internal referrer = makeAddr("referrer");
    address internal stranger = makeAddr("stranger");

    uint256 internal constant ARBITER_PK = 0xA11CE;
    uint256 internal constant MARKET_PK = 0xB0B;
    address internal arbiter;

    uint16 internal constant PLATFORM_FEE_BPS = 50;
    uint16 internal constant ARBITRATION_FEE_BPS = 200;
    uint256 internal constant AMOUNT = 1_000e6;
    uint64 internal constant REVIEW_WINDOW = 1 days;
    uint64 internal deliveryDeadline;

    function setUp() public {
        arbiter = vm.addr(ARBITER_PK);
        token = new MockStablecoin();
        (escrow, implementation) = TempexDeployment.deploy(
            ITIP20(address(token)), owner, arbiter, treasury, PLATFORM_FEE_BPS, ARBITRATION_FEE_BPS
        );
        token.mint(buyer, 1_000_000e6);
        vm.prank(buyer);
        token.approve(address(escrow), type(uint256).max);
        deliveryDeadline = uint64(block.timestamp + 7 days);
    }

    // ------------------------------------------------------------ helpers

    function _create(uint256 amount) internal returns (uint256 jobId) {
        vm.prank(buyer);
        jobId = escrow.createJob(seller, amount, keccak256("t"), deliveryDeadline, REVIEW_WINDOW);
    }

    function _fund(uint256 jobId) internal {
        vm.prank(buyer);
        escrow.fund(jobId);
    }

    function _deliver(uint256 jobId) internal {
        vm.prank(seller);
        escrow.deliver(jobId, keccak256("d"), "");
    }

    function _disputeAndRespond(uint256 jobId) internal {
        vm.prank(buyer);
        escrow.dispute(jobId, keccak256("c"), 0);
        vm.prank(seller);
        escrow.respond(jobId, keccak256("r"), 10_000);
    }

    function _resolve(uint256 jobId, uint256 pk, uint16 award) internal {
        TempexEscrow.Verdict memory verdict = TempexEscrow.Verdict({
            jobId: jobId,
            sellerAwardBps: award,
            evidenceHash: keccak256("c"),
            rationaleHash: keccak256("why"),
            issuedAt: uint64(block.timestamp),
            validUntil: uint64(block.timestamp + 1 hours)
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, escrow.verdictDigest(verdict));
        escrow.resolve(jobId, verdict, abi.encodePacked(r, s, v));
    }

    function _referredJob(uint256 amount, address judge) internal returns (uint256 jobId) {
        vm.prank(buyer);
        jobId = escrow.createJobWithReferrer(
            seller, amount, keccak256("t"), deliveryDeadline, REVIEW_WINDOW, judge, referrer
        );
        _fund(jobId);
    }

    // ------------------------------------------------------- proxy & upgrades

    function test_ProxyIsInitializedWithDefaults() public view {
        assertEq(escrow.owner(), owner);
        assertEq(address(escrow.paymentToken()), address(token));
        assertEq(escrow.arbiter(), arbiter);
        assertEq(escrow.protocolCutBps(), 2_000);
        assertEq(escrow.maxJobAmount(), type(uint256).max);
        assertEq(escrow.maxOpenValue(), type(uint256).max);
        assertFalse(escrow.newJobsPaused());
        assertEq(escrow.version(), "3.0.0");
    }

    function test_ProxyCannotBeInitializedTwice() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        escrow.initialize(ITIP20(address(token)), stranger, stranger, stranger, 0, 0);
    }

    function test_ImplementationCannotBeInitialized() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        TempexEscrow(implementation).initialize(ITIP20(address(token)), stranger, stranger, stranger, 0, 0);
    }

    function test_OnlyOwnerCanUpgrade() public {
        address next = address(new TempexEscrowNext());
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, stranger));
        escrow.upgradeToAndCall(next, "");
    }

    function test_UpgradeKeepsJobsCreditsAndTheVerdictDomain() public {
        uint256 settled = _create(AMOUNT);
        _fund(settled);
        _deliver(settled);
        vm.prank(buyer);
        escrow.accept(settled);
        uint256 inFlight = _create(AMOUNT);
        _fund(inFlight);
        _deliver(inFlight);
        _disputeAndRespond(inFlight);

        TempexEscrow.Verdict memory probe = TempexEscrow.Verdict(inFlight, 5_000, keccak256("c"), 0, 1, 2);
        bytes32 digestBefore = escrow.verdictDigest(probe);
        uint256 sellerCredit = escrow.credits(seller);

        address next = address(new TempexEscrowNext());
        vm.prank(owner);
        escrow.upgradeToAndCall(next, "");

        assertEq(escrow.version(), "3.1.0-test");
        assertEq(escrow.jobCount(), 2);
        assertEq(escrow.credits(seller), sellerCredit);
        assertEq(escrow.openValue(), AMOUNT);
        assertEq(escrow.verdictDigest(probe), digestBefore, "signed verdicts survive the upgrade");
        // the dispute opened before the upgrade still settles after it
        _resolve(inFlight, ARBITER_PK, 5_000);
        assertEq(uint8(escrow.getJob(inFlight).state), uint8(TempexEscrow.JobState.Settled));
        assertEq(escrow.openValue(), 0);
    }

    // --------------------------------------------------------------- pause

    function test_PauseStopsNewJobsAndFunding() public {
        uint256 unfunded = _create(AMOUNT);
        vm.prank(owner);
        escrow.setNewJobsPaused(true);

        vm.prank(buyer);
        vm.expectRevert("new jobs paused");
        escrow.createJob(seller, AMOUNT, keccak256("t"), deliveryDeadline, REVIEW_WINDOW);
        vm.prank(buyer);
        vm.expectRevert("new jobs paused");
        escrow.fund(unfunded);
        vm.prank(buyer);
        vm.expectRevert("new jobs paused");
        escrow.createJobWithReferrer(seller, AMOUNT, keccak256("t"), deliveryDeadline, REVIEW_WINDOW, address(0), referrer);
    }

    function test_PauseNeverTrapsJobsInFlight() public {
        uint256 accepted = _create(AMOUNT);
        _fund(accepted);
        uint256 disputed = _create(AMOUNT);
        _fund(disputed);
        uint256 expired = _create(AMOUNT);
        _fund(expired);

        vm.prank(owner);
        escrow.setNewJobsPaused(true);

        _deliver(accepted);
        vm.prank(buyer);
        escrow.accept(accepted);

        _deliver(disputed);
        _disputeAndRespond(disputed);
        _resolve(disputed, ARBITER_PK, 4_000);

        vm.warp(deliveryDeadline + 1);
        escrow.refundExpired(expired);

        vm.prank(seller);
        escrow.withdraw();
        vm.prank(buyer);
        escrow.withdraw();
        assertEq(escrow.openValue(), 0);
    }

    function test_OnlyOwnerSetsGuards() public {
        vm.startPrank(stranger);
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, stranger));
        escrow.setNewJobsPaused(true);
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, stranger));
        escrow.setLimits(1, 1);
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, stranger));
        escrow.setArbitrationFeeFloor(1);
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, stranger));
        escrow.setReferralShare(1);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- caps

    function test_JobCapRejectsLargeJobsAtCreateAndFund() public {
        uint256 big = _create(AMOUNT);
        vm.prank(owner);
        escrow.setLimits(AMOUNT - 1, type(uint256).max);

        vm.prank(buyer);
        vm.expectRevert("amount above job cap");
        escrow.createJob(seller, AMOUNT, keccak256("t"), deliveryDeadline, REVIEW_WINDOW);
        // a job created under a looser cap cannot be funded under the tighter one
        vm.prank(buyer);
        vm.expectRevert("amount above job cap");
        escrow.fund(big);
        _fund(_create(AMOUNT - 1));
    }

    function test_OpenValueCapCountsOnlyJobsStillHoldingMoney() public {
        vm.prank(owner);
        escrow.setLimits(type(uint256).max, 2 * AMOUNT);
        uint256 a = _create(AMOUNT);
        _fund(a);
        uint256 b = _create(AMOUNT);
        _fund(b);
        assertEq(escrow.openValue(), 2 * AMOUNT);

        uint256 c = _create(AMOUNT);
        vm.prank(buyer);
        vm.expectRevert("escrow cap reached");
        escrow.fund(c);

        // settling one frees room for the next
        _deliver(a);
        vm.prank(buyer);
        escrow.accept(a);
        assertEq(escrow.openValue(), AMOUNT);
        _fund(c);
        assertEq(escrow.openValue(), 2 * AMOUNT);
    }

    function test_OpenValueFallsOnEveryExit() public {
        uint256 lapsed = _create(AMOUNT);
        _fund(lapsed);
        _deliver(lapsed);
        _disputeAndRespond(lapsed);
        uint256 cancelled = _create(AMOUNT);
        assertEq(escrow.openValue(), AMOUNT, "an unfunded job holds nothing");
        vm.prank(buyer);
        escrow.cancel(cancelled);

        vm.warp(block.timestamp + escrow.ARBITRATION_WINDOW() + 1);
        escrow.settleLapsed(lapsed);
        assertEq(escrow.openValue(), 0);
    }

    function test_CapsCannotBeZero() public {
        vm.prank(owner);
        vm.expectRevert("cap=0; pause instead");
        escrow.setLimits(0, 1);
    }

    // ----------------------------------------------------------- fee floor

    function test_FloorRaisesTheFeeOnSmallJobs() public {
        vm.prank(owner);
        escrow.setArbitrationFeeFloor(0.5e6);
        uint256 small = _create(5e6); // 2% would be 0.10
        uint256 large = _create(AMOUNT); // 2% is 20, above the floor
        assertEq(escrow.arbitrationFee(small), 0.5e6);
        assertEq(escrow.arbitrationFee(large), 20e6);
    }

    function test_FloorIsAnnouncedForIndexers() public {
        vm.prank(owner);
        escrow.setArbitrationFeeFloor(0.5e6);
        vm.expectEmit(true, false, false, true, address(escrow));
        emit TempexEscrow.ArbitrationFeeFloorLocked(1, 0.5e6);
        _create(5e6);
    }

    function test_FloorNeverExceedsTheJobAmount() public {
        vm.prank(owner);
        escrow.setArbitrationFeeFloor(10e6);
        uint256 tiny = _create(1e6);
        assertEq(escrow.arbitrationFee(tiny), 1e6);
    }

    function test_FloorIsLockedAtCreation() public {
        uint256 before = _create(5e6);
        vm.prank(owner);
        escrow.setArbitrationFeeFloor(0.5e6);
        uint256 afterwards = _create(5e6);
        assertEq(escrow.arbitrationFee(before), 0.1e6, "a job keeps the floor it was created with");
        assertEq(escrow.arbitrationFee(afterwards), 0.5e6);
    }

    function test_FreeArbiterStaysFree() public {
        vm.prank(owner);
        escrow.setArbitrationFeeFloor(0.5e6);
        address judge = vm.addr(MARKET_PK);
        vm.prank(judge);
        escrow.listArbiter(0, "");
        vm.prank(buyer);
        uint256 jobId = escrow.createJobWithArbiter(seller, 5e6, keccak256("t"), deliveryDeadline, REVIEW_WINDOW, judge);
        assertEq(escrow.arbitrationFee(jobId), 0);
    }

    /// Whatever the award, the floor and the job size, a ruling pays out exactly
    /// the escrowed amount plus the bond: nothing created, nothing stranded.
    function testFuzz_FlooredRulingConservesMoney(uint256 amount, uint256 floor, uint16 award) public {
        amount = bound(amount, 1, 100_000e6);
        floor = bound(floor, 0, 1_000e6);
        award = uint16(bound(award, 0, 10_000));
        vm.prank(owner);
        escrow.setArbitrationFeeFloor(floor);
        uint256 jobId = _create(amount);
        _fund(jobId);
        _deliver(jobId);
        _disputeAndRespond(jobId);
        uint256 bond = escrow.disputeBond(jobId);
        uint256 fee = escrow.arbitrationFee(jobId);

        _resolve(jobId, ARBITER_PK, award);

        uint256 paid = escrow.credits(seller) + escrow.credits(buyer) + escrow.credits(arbiter)
            + escrow.credits(treasury);
        assertEq(paid, amount + bond);
        assertEq(escrow.credits(treasury), fee, "the house arbiter's whole fee goes to the treasury");
        assertEq(token.balanceOf(address(escrow)), paid);
    }

    // ------------------------------------------------------------ referrals

    function test_ReferrerEarnsItsShareOfThePlatformFee() public {
        vm.prank(owner);
        escrow.setReferralShare(3_000);
        uint256 jobId = _referredJob(AMOUNT, address(0));
        (address who, uint16 share,) = escrow.jobExtras(jobId);
        assertEq(who, referrer);
        assertEq(share, 3_000);

        _deliver(jobId);
        vm.expectEmit(true, true, false, true, address(escrow));
        emit TempexEscrow.ReferralPaid(jobId, referrer, 1.5e6);
        vm.prank(buyer);
        escrow.accept(jobId);

        uint256 platformFee = (AMOUNT * PLATFORM_FEE_BPS) / 10_000; // 5
        assertEq(escrow.credits(referrer), 1.5e6);
        assertEq(escrow.credits(treasury), platformFee - 1.5e6);
        assertEq(escrow.credits(seller), AMOUNT - platformFee);
    }

    function test_ReferrerEarnsItsShareOfTheProtocolsArbitrationCut() public {
        vm.prank(owner);
        escrow.setReferralShare(5_000);
        address judge = vm.addr(MARKET_PK);
        vm.prank(judge);
        escrow.listArbiter(300, "");
        uint256 jobId = _referredJob(AMOUNT, judge);
        _deliver(jobId);
        _disputeAndRespond(jobId);
        _resolve(jobId, MARKET_PK, 6_000);

        uint256 fee = (AMOUNT * 300) / 10_000; // 30
        uint256 protocolShare = (fee * 2_000) / 10_000; // 6
        assertEq(escrow.credits(judge), fee - protocolShare);
        assertEq(escrow.credits(referrer), protocolShare / 2);
        assertEq(escrow.credits(treasury), protocolShare - protocolShare / 2);
    }

    function test_ReferralShareIsLockedAtCreation() public {
        vm.prank(owner);
        escrow.setReferralShare(3_000);
        uint256 jobId = _referredJob(AMOUNT, address(0));
        vm.prank(owner);
        escrow.setReferralShare(0);
        _deliver(jobId);
        vm.prank(buyer);
        escrow.accept(jobId);
        assertEq(escrow.credits(referrer), 1.5e6);
    }

    function test_PartiesCannotReferThemselves() public {
        vm.startPrank(buyer);
        vm.expectRevert("party cannot refer");
        escrow.createJobWithReferrer(seller, AMOUNT, keccak256("t"), deliveryDeadline, REVIEW_WINDOW, address(0), buyer);
        vm.expectRevert("party cannot refer");
        escrow.createJobWithReferrer(seller, AMOUNT, keccak256("t"), deliveryDeadline, REVIEW_WINDOW, address(0), seller);
        vm.expectRevert("referrer=0");
        escrow.createJobWithReferrer(seller, AMOUNT, keccak256("t"), deliveryDeadline, REVIEW_WINDOW, address(0), address(0));
        vm.stopPrank();
    }

    function test_ReferralShareIsCapped() public {
        vm.prank(owner);
        vm.expectRevert("referralShare too high");
        escrow.setReferralShare(5_001);
    }

    function test_UnreferredJobsPayTheTreasuryAsBefore() public {
        vm.prank(owner);
        escrow.setReferralShare(5_000);
        uint256 jobId = _create(AMOUNT);
        _fund(jobId);
        _deliver(jobId);
        vm.prank(buyer);
        escrow.accept(jobId);
        assertEq(escrow.credits(treasury), (AMOUNT * PLATFORM_FEE_BPS) / 10_000);
        assertEq(escrow.credits(referrer), 0);
    }
}
