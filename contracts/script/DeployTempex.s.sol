// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {ITIP20} from "../src/ITIP20.sol";
import {TempexEscrow} from "../src/TempexEscrow.sol";

/// @notice Deploys TempexEscrow. Requires TEMPEX_TOKEN, TEMPEX_ARBITER,
/// TEMPEX_TREASURY and a broadcast signer (--private-key or --interactive).
contract DeployTempex is Script {
    function run() external returns (TempexEscrow escrow) {
        address token = vm.envAddress("TEMPEX_TOKEN");
        address arbiter = vm.envAddress("TEMPEX_ARBITER");
        address treasury = vm.envAddress("TEMPEX_TREASURY");
        uint16 platformFeeBps = uint16(vm.envOr("TEMPEX_PLATFORM_FEE_BPS", uint256(50)));
        uint16 arbitrationFeeBps = uint16(vm.envOr("TEMPEX_ARBITRATION_FEE_BPS", uint256(200)));

        vm.startBroadcast();
        escrow = new TempexEscrow(
            ITIP20(token), msg.sender, arbiter, treasury, platformFeeBps, arbitrationFeeBps
        );
        vm.stopBroadcast();

        console.log("TempexEscrow deployed at", address(escrow));
        console.log("  payment token (TIP-20):", token);
        console.log("  arbiter:               ", arbiter);
        console.log("  treasury:              ", treasury);
        console.log("  platformFeeBps:        ", platformFeeBps);
        console.log("  arbitrationFeeBps:     ", arbitrationFeeBps);
    }
}
