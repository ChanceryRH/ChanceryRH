// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAllowanceModule {
    function executeAllowanceTransfer(address safe, address token, address payable to, uint96 amount,
        address paymentToken, uint96 payment, address delegate, bytes calldata signature) external;
    function getTokenAllowance(address safe, address delegate, address token) external view returns (uint256[5] memory);
}
interface IERC20Balance { function balanceOf(address owner) external view returns (uint256); }
interface ISafeView { function getThreshold() external view returns (uint256); }

/// @notice An append-only statement of actual fixed-recipient USDG transfers.
contract SettlementLog {
    ChanceryRegistry public immutable registry;
    mapping(bytes32 => bool) public recorded;
    event Settled(bytes32 indexed officeId, bytes32 indexed actorId, bytes32 indexed batchId,
        uint64 day, uint96 amount, bytes32 receiptRoot, uint32 receiptCount, uint32 allowancePeriod);
    constructor(address registry_) { registry = ChanceryRegistry(registry_); }
    function record(bytes32 officeId, bytes32 actorId, bytes32 batchId, uint64 day, uint96 amount,
        bytes32 receiptRoot, uint32 receiptCount, uint32 allowancePeriod) external {
        require(registry.delegates(officeId, actorId) == msg.sender, "delegate only");
        bytes32 key = keccak256(abi.encode(officeId, actorId, batchId));
        require(!recorded[key], "duplicate batch");
        recorded[key] = true;
        emit Settled(officeId, actorId, batchId, day, amount, receiptRoot, receiptCount, allowancePeriod);
    }
}

/// @notice The module delegate is this contract, never the settlement operator EOA.
/// Its only transfer path fixes the recipient/token and records the receipt root atomically.
contract SettlementDelegate {
    ChanceryRegistry public immutable registry;
    address public immutable safe;
    bytes32 public immutable officeId;
    bytes32 public immutable actorId;
    bool private locked;
    mapping(bytes32 => bool) public settled;
    mapping(bytes32 => bool) public settledRoots;
    constructor(address registry_, address safe_, bytes32 officeId_, bytes32 actorId_) {
        registry = ChanceryRegistry(registry_); safe = safe_; officeId = officeId_; actorId = actorId_;
    }
    function settle(bytes32 batchId, uint64 day, uint32 expectedPeriod, bytes32 receiptRoot,
        uint32 receiptCount, uint96 amount) external {
        require(msg.sender == registry.operator(), "operator only");
        require(!locked, "reentrant");
        require(!settled[batchId] && batchId != bytes32(0), "duplicate batch");
        require(!settledRoots[receiptRoot], "duplicate receipts");
        require(day <= block.timestamp / 1 days, "future day");
        require(amount > 0 && receiptCount > 0 && receiptRoot != bytes32(0), "empty settlement");
        locked = true; settled[batchId] = true; settledRoots[receiptRoot] = true;
        registry.consume(officeId, actorId, amount, expectedPeriod);
        address token = registry.token(); address treasury = registry.treasury();
        uint256[5] memory allowance = IAllowanceModule(registry.allowanceModule()).getTokenAllowance(safe, address(this), token);
        require(allowance[2] == registry.PERIOD_MINUTES() && allowance[3] == expectedPeriod, "module period mismatch");
        uint256 beforeBalance = IERC20Balance(token).balanceOf(treasury);
        IAllowanceModule(registry.allowanceModule()).executeAllowanceTransfer(
            safe, token, payable(treasury), amount, address(0), 0, address(this), "");
        require(IERC20Balance(token).balanceOf(treasury) == beforeBalance + amount, "transfer mismatch");
        registry.settlementLog().record(officeId, actorId, batchId, day, amount, receiptRoot, receiptCount, expectedPeriod);
        locked = false;
    }
}

/// @notice Office authority is its Safe. All delegates share an additional total Office cap.
/// The 43,200-minute cycle is explicitly 30 days, not a calendar month.
contract ChanceryRegistry {
    uint32 public constant PERIOD_MINUTES = 43_200;
    uint96 public constant MAX_OFFICE_CAP = 5_000 * 1e6;
    address public immutable administrator;
    address public immutable token;
    address public immutable treasury;
    address public immutable allowanceModule;
    address public operator;
    SettlementLog public immutable settlementLog;
    struct Office {
        address safe;
        bytes32 seatRoot;
        bytes32 policyHash;
        uint96 cap;
        uint96 spent;
        uint32 periodStart;
        bool active;
    }
    mapping(bytes32 => Office) public offices;
    mapping(bytes32 => mapping(bytes32 => address)) public delegates;
    mapping(bytes32 => mapping(bytes32 => bool)) public actorActive;
    mapping(bytes32 => bytes32) public anchors;
    event OfficeOpened(bytes32 indexed officeId, address indexed safe, address delegate);
    event SeatsUpdated(bytes32 indexed officeId, bytes32 seatRoot);
    event PolicyUpdated(bytes32 indexed officeId, bytes32 policyHash);
    event CapUpdated(bytes32 indexed officeId, uint96 cap);
    event ClerkSet(bytes32 indexed officeId, bytes32 indexed actorId, address delegate, bool active);
    event OfficeClosed(bytes32 indexed officeId);
    event OperatorChanged(address indexed operator);
    event ReceiptsAnchored(bytes32 indexed officeId, uint64 indexed hour, bytes32 root, uint32 count);
    event MinutesAnchored(bytes32 indexed officeId, bytes32 indexed bodyHash, bytes32 signatureHash);

    constructor(address token_, address treasury_, address module_, address administrator_, address operator_) {
        require(token_.code.length > 0 && module_.code.length > 0, "contracts required");
        require(treasury_ != address(0) && administrator_ != address(0) && operator_ != address(0), "zero address");
        token = token_; treasury = treasury_; allowanceModule = module_;
        administrator = administrator_; operator = operator_;
        settlementLog = new SettlementLog(address(this));
    }
    function officeIdFor(address safe) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, safe));
    }
    function _owned(bytes32 officeId) private view {
        require(offices[officeId].safe == msg.sender, "Safe only");
    }
    function delegateAddress(address safe, bytes32 actorId) public view returns (address) {
        bytes32 officeId = officeIdFor(safe);
        bytes32 salt = keccak256(abi.encode(officeId, actorId));
        bytes32 codeHash = keccak256(abi.encodePacked(type(SettlementDelegate).creationCode,
            abi.encode(address(this), safe, officeId, actorId)));
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, codeHash)))));
    }
    function _delegate(address safe, bytes32 officeId, bytes32 actorId) private returns (address deployed) {
        deployed = delegates[officeId][actorId];
        if (deployed == address(0)) {
            bytes32 salt = keccak256(abi.encode(officeId, actorId));
            deployed = address(new SettlementDelegate{salt: salt}(address(this), safe, officeId, actorId));
            delegates[officeId][actorId] = deployed;
        }
    }
    function open(bytes32 seatRoot, bytes32 policyHash, uint96 cap) external returns (bytes32 officeId) {
        require(msg.sender.code.length > 0 && ISafeView(msg.sender).getThreshold() > 0, "Safe required");
        require(cap > 0 && cap <= MAX_OFFICE_CAP, "cap limit");
        require(seatRoot != bytes32(0) && policyHash != bytes32(0), "empty commitment");
        officeId = officeIdFor(msg.sender);
        require(offices[officeId].safe == address(0), "Office exists");
        offices[officeId] = Office(msg.sender, seatRoot, policyHash, cap, 0, uint32(block.timestamp / 60), true);
        address delegate = _delegate(msg.sender, officeId, bytes32(0));
        actorActive[officeId][bytes32(0)] = true;
        emit OfficeOpened(officeId, msg.sender, delegate);
        emit SeatsUpdated(officeId, seatRoot); emit PolicyUpdated(officeId, policyHash);
    }
    function setSeats(bytes32 officeId, bytes32 seatRoot) external {
        _owned(officeId); require(seatRoot != bytes32(0), "empty root");
        offices[officeId].seatRoot = seatRoot; emit SeatsUpdated(officeId, seatRoot);
    }
    function setPolicy(bytes32 officeId, bytes32 policyHash) external {
        _owned(officeId); require(policyHash != bytes32(0), "empty policy");
        offices[officeId].policyHash = policyHash; emit PolicyUpdated(officeId, policyHash);
    }
    function setCap(bytes32 officeId, uint96 cap) external {
        _owned(officeId); require(cap <= MAX_OFFICE_CAP, "cap limit");
        offices[officeId].cap = cap; emit CapUpdated(officeId, cap);
    }
    function setClerk(bytes32 officeId, bytes32 actorId, bool active) external returns (address delegate) {
        _owned(officeId); require(actorId != bytes32(0), "reserved actor");
        delegate = _delegate(msg.sender, officeId, actorId);
        actorActive[officeId][actorId] = active;
        emit ClerkSet(officeId, actorId, delegate, active);
    }
    function close(bytes32 officeId) external {
        _owned(officeId); offices[officeId].active = false; emit OfficeClosed(officeId);
    }
    function setOperator(address next) external {
        require(msg.sender == administrator && next != address(0), "admin only");
        operator = next; emit OperatorChanged(next);
    }
    function budget(bytes32 officeId) public view returns (uint96 cap, uint96 spent, uint32 periodStart) {
        Office storage o = offices[officeId];
        cap = o.cap; spent = o.spent; periodStart = o.periodStart;
        uint32 nowMin = uint32(block.timestamp / 60);
        if (nowMin >= periodStart + PERIOD_MINUTES) {
            periodStart += ((nowMin - periodStart) / PERIOD_MINUTES) * PERIOD_MINUTES; spent = 0;
        }
    }
    function consume(bytes32 officeId, bytes32 actorId, uint96 amount, uint32 expectedPeriod) external {
        Office storage o = offices[officeId];
        require(o.active && actorActive[officeId][actorId], "inactive");
        require(delegates[officeId][actorId] == msg.sender, "delegate only");
        (uint96 cap, uint96 spent, uint32 periodStart) = budget(officeId);
        require(periodStart == expectedPeriod, "stale period");
        require(uint256(spent) + amount <= cap, "Office cap");
        o.periodStart = periodStart; o.spent = spent + amount;
    }
    function anchorReceipts(bytes32 officeId, uint64 hour, bytes32 root, uint32 count) external {
        require(msg.sender == operator && offices[officeId].safe != address(0), "operator only");
        require(hour <= block.timestamp / 1 hours && count > 0 && root != bytes32(0), "invalid anchor");
        bytes32 key = keccak256(abi.encode(officeId, hour));
        require(anchors[key] == bytes32(0), "already anchored");
        anchors[key] = root; emit ReceiptsAnchored(officeId, hour, root, count);
    }
    function anchorMinutes(bytes32 officeId, bytes32 bodyHash, bytes32 signatureHash) external {
        require(msg.sender == operator && offices[officeId].active, "operator only");
        require(bodyHash != bytes32(0) && signatureHash != bytes32(0), "empty minutes");
        emit MinutesAnchored(officeId, bodyHash, signatureHash);
    }
}
