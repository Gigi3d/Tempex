// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {ITIP20} from "../src/ITIP20.sol";
import {TempexEscrow} from "../src/TempexEscrow.sol";

/// @notice Deploys TempexEscrow the only supported way: an implementation behind
/// an ERC-1967 proxy, initialized in the proxy's own constructor so nobody can
/// front-run the initialization. Shared by the deploy script and the tests.
library TempexDeployment {
    function deploy(
        ITIP20 token,
        address owner,
        address arbiter,
        address treasury,
        uint16 platformFeeBps,
        uint16 arbitrationFeeBps
    ) internal returns (TempexEscrow escrow, address implementation) {
        implementation = address(new TempexEscrow());
        bytes memory init = abi.encodeCall(
            TempexEscrow.initialize,
            (token, owner, arbiter, treasury, platformFeeBps, arbitrationFeeBps)
        );
        escrow = TempexEscrow(address(new ERC1967Proxy(implementation, init)));
    }
}
