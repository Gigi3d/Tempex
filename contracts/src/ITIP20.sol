// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title ITIP20
/// @notice Tempo's payment token standard: ERC-20 plus a 32-byte memo on transfers.
///
/// The memo functions revert on failure (custom errors) and return no value, unlike
/// ERC-20 `transfer`/`transferFrom` which return a bool. Neither is declared here as
/// returning `bool`, so callers must not use SafeERC20's return-value checks on them.
interface ITIP20 is IERC20 {
    /// @notice Emitted alongside {Transfer} whenever a memo-carrying transfer settles.
    event TransferWithMemo(
        address indexed from, address indexed to, uint256 amount, bytes32 indexed memo
    );

    /// @notice Moves `amount` to `to`, tagging the transfer with a 32-byte `memo`.
    function transferWithMemo(address to, uint256 amount, bytes32 memo) external;

    /// @notice Moves `amount` from `from` to `to` using allowance, tagging it with `memo`.
    function transferFromWithMemo(address from, address to, uint256 amount, bytes32 memo)
        external;
}
