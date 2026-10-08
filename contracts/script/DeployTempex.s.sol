// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {ITIP20} from "../src/ITIP20.sol";
import {TempexEscrow} from "../src/TempexEscrow.sol";
import {TempexDeployment} from "./TempexDeployment.sol";

/// @notice Deploys TempexEscrow behind an ERC-1967 proxy and sets its launch
/// guards in the same broadcast. Requires TEMPEX_TOKEN, TEMPEX_ARBITER,
/// TEMPEX_TREASURY and a broadcast signer (--private-key or --interactive); the
/// signer becomes the owner, the one key that can upgrade the escrow.
///
/// Optional, in token base units (6 decimals) unless noted:
///   TEMPEX_MAX_JOB_AMOUNT      largest single job (default: no cap)
///   TEMPEX_MAX_OPEN_VALUE      most value held by open jobs (default: no cap)
///   TEMPEX_ARBITRATION_FLOOR   minimum arbitration fee (default 0)
///   TEMPEX_REFERRAL_SHARE_BPS  referrers' share of protocol fees, bps (default 0)
contract DeployTempex is Script {
    function run() external returns (TempexEscrow escrow) {
        address token = vm.envAddress("TEMPEX_TOKEN");
        address arbiter = vm.envAddress("TEMPEX_ARBITER");
        address treasury = vm.envAddress("TEMPEX_TREASURY");
        uint16 platformFeeBps = uint16(vm.envOr("TEMPEX_PLATFORM_FEE_BPS", uint256(50)));
        uint16 arbitrationFeeBps = uint16(vm.envOr("TEMPEX_ARBITRATION_FEE_BPS", uint256(200)));
        uint256 maxJobAmount = vm.envOr("TEMPEX_MAX_JOB_AMOUNT", type(uint256).max);
        uint256 maxOpenValue = vm.envOr("TEMPEX_MAX_OPEN_VALUE", type(uint256).max);
        uint256 floor = vm.envOr("TEMPEX_ARBITRATION_FLOOR", uint256(0));
        uint16 referralShareBps = uint16(vm.envOr("TEMPEX_REFERRAL_SHARE_BPS", uint256(0)));

        vm.startBroadcast();
        address implementation;
        (escrow, implementation) = TempexDeployment.deploy(
            ITIP20(token), msg.sender, arbiter, treasury, platformFeeBps, arbitrationFeeBps
        );
        if (maxJobAmount != type(uint256).max || maxOpenValue != type(uint256).max) {
            escrow.setLimits(maxJobAmount, maxOpenValue);
        }
        if (floor != 0) escrow.setArbitrationFeeFloor(floor);
        if (referralShareBps != 0) escrow.setReferralShare(referralShareBps);
        vm.stopBroadcast();

        console.log("TempexEscrow proxy at   ", address(escrow));
        console.log("  implementation:       ", implementation);
        console.log("  owner (upgrade key):  ", msg.sender);
        console.log("  payment token (TIP-20):", token);
        console.log("  arbiter:              ", arbiter);
        console.log("  treasury:             ", treasury);
        console.log("  platformFeeBps:       ", platformFeeBps);
        console.log("  arbitrationFeeBps:    ", arbitrationFeeBps);
        console.log("  arbitration floor:    ", floor);
        console.log("  referralShareBps:     ", referralShareBps);
    }
}
