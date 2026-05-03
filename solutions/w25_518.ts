// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

/**
 * @title DRISeatManager
 * @notice Manages 4 DRI seats: Treasury, Platform, Correspondent Success, Revenue
 * @dev Each seat is an autonomous agent with full department ownership
 */
contract DRISeatManager is AccessControl, ReentrancyGuard {
    bytes32 public constant PUBLISHER_ROLE = keccak256("PUBLISHER_ROLE");
    bytes32 public constant DRI_ROLE = keccak256("DRI_ROLE");
    bytes32 public constant AGENT_ROLE = keccak256("AGENT_ROLE");

    // Seat types
    enum SeatType { Treasury, Platform, CorrespondentSuccess, Revenue }

    // Seat status
    enum SeatStatus { Vacant, Filled, Suspended }

    // Department structure
    struct Department {
        SeatType seatType;
        address seatHolder;
        SeatStatus status;
        uint256 createdAt;
        uint256 lastLoopExecution;
        uint256 loopInterval;
        string strategy;
        string tooling;
        uint256 totalRevenue;
        uint256 totalExpenses;
        bool isAutonomous;
    }

    // Loop execution record
    struct LoopExecution {
        uint256 timestamp;
        bytes32 actionHash;
        bool success;
        string actionDescription;
    }

    // Mapping from seat type to department
    mapping(SeatType => Department) public departments;

    // Mapping from seat holder to their departments
    mapping(address => SeatType[]) public holderSeats;

    // Loop execution history
    mapping(SeatType => LoopExecution[]) public loopHistory;

    // Events
    event SeatFilled(SeatType indexed seatType, address indexed holder, uint256 timestamp);
    event SeatVacated(SeatType indexed seatType, address indexed previousHolder, uint256 timestamp);
    event LoopExecuted(SeatType indexed seatType, bytes32 actionHash, bool success, uint256 timestamp);
    event StrategyUpdated(SeatType indexed seatType, string newStrategy, uint256 timestamp);
    event ToolingUpdated(SeatType indexed seatType, string newTooling, uint256 timestamp);
    event RevenueReported(SeatType indexed seatType, uint256 amount, uint256 timestamp);
    event ExpenseReported(SeatType indexed seatType, uint256 amount, uint256 timestamp);
    event SeatSuspended(SeatType indexed seatType, uint256 timestamp);
    event SeatReactivated(SeatType indexed seatType, uint256 timestamp);

    // Modifiers
    modifier onlyPublisher() {
        require(hasRole(PUBLISHER_ROLE, msg.sender), "Caller is not Publisher");
        _;
    }

    modifier onlySeatHolder(SeatType _seatType) {
        require(departments[_seatType].seatHolder == msg.sender, "Caller is not seat holder");
        _;
    }

    modifier onlyActiveSeat(SeatType _seatType) {
        require(departments[_seatType].status == SeatStatus.Filled, "Seat is not active");
        _;
    }

    modifier onlyAutonomousSeat(SeatType _seatType) {
        require(departments[_seatType].isAutonomous, "Seat is not autonomous");
        _;
    }

    /**
     * @notice Constructor sets up the Publisher role and initializes seats
     */
    constructor() {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(PUBLISHER_ROLE, msg.sender);
        
        // Initialize all 4 seats as vacant
        _initializeSeat(SeatType.Treasury);
        _initializeSeat(SeatType.Platform);
        _initializeSeat(SeatType.CorrespondentSuccess);
        _initializeSeat(SeatType.Revenue);
    }

    /**
     * @notice Initialize a seat with default values
     */
    function _initializeSeat(SeatType _seatType) private {
        departments[_seatType] = Department({
            seatType: _seatType,
            seatHolder: address(0),
            status: SeatStatus.Vacant,
            createdAt: block.timestamp,
            lastLoopExecution: 0,
            loopInterval: 1 hours, // Default loop interval
            strategy: "",
            tooling: "",
            totalRevenue: 0,
            totalExpenses: 0,
            isAutonomous: true
        });
    }

    /**
     * @notice Fill a vacant seat with a new holder
     * @param _seatType Type of seat to fill
     * @param _holder Address of the new seat holder
     */
    function fillSeat(SeatType _seatType, address _holder) external onlyPublisher {
        require(departments[_seatType].status == SeatStatus.Vacant, "Seat is not vacant");
        require(_holder != address(0), "Invalid holder address");
        require(!hasRole(DRI_ROLE, _holder), "Address already has a DRI role");

        departments[_seatType].seatHolder = _holder;
        departments[_seatType].status = SeatStatus.Filled;
        departments[_seatType].lastLoopExecution = block.timestamp;
        
        _grantRole(DRI_ROLE, _holder);
        _grantRole(AGENT_ROLE, _holder);
        holderSeats[_holder].push(_seatType);

        emit SeatFilled(_seatType, _holder, block.timestamp);
    }

    /**
     * @notice Vacate a seat (holder resigns or Publisher removes)
     * @param _seatType Type of seat to vacate
     */
    function vacateSeat(SeatType _seatType) external {
        require(
            msg.sender == departments[_seatType].seatHolder || 
            hasRole(PUBLISHER_ROLE, msg.sender),
            "Not authorized to vacate seat"
        );
        require(departments[_seatType].status == SeatStatus.Filled, "Seat is not filled");

        address previousHolder = departments[_seatType].seatHolder;
        
        departments[_seatType].seatHolder = address(0);
        departments[_seatType].status = SeatStatus.Vacant;
        
        _revokeRole(DRI_ROLE, previousHolder);
        _revokeRole(AGENT_ROLE, previousHolder);
        
        // Remove from holder's seat list
        _removeHolderSeat(previousHolder, _seatType);

        emit SeatVacated(_seatType, previousHolder, block.timestamp);
    }

    /**
     * @notice Execute an autonomous loop for a seat
     * @param _seatType Type of seat executing the loop
     * @param _actionHash Hash of the action being executed
     * @param _actionDescription Description of the action
     * @return success Whether the loop execution was successful
     */
    function executeLoop(
        SeatType _seatType,
        bytes32 _actionHash,
        string calldata _actionDescription
    ) external onlySeatHolder(_seatType) onlyActiveSeat(_seatType) onlyAutonomousSeat(_seatType) returns (bool) {
        require(
            block.timestamp >= departments[_seatType].lastLoopExecution + departments[_seatType].loopInterval,
            "Loop interval not elapsed"
        );

        bool success = _processLoopAction(_seatType, _actionHash);
        
        departments[_seatType].lastLoopExecution = block.timestamp;
        
        loopHistory[_seatType].push(LoopExecution({
            timestamp: block.timestamp,
            actionHash: _actionHash,
            success: success,
            actionDescription: _actionDescription
        }));

        emit LoopExecuted(_seatType, _actionHash, success, block.timestamp);
        
        return success;
    }

    /**
     * @notice Internal function to process loop actions based on seat type
     */
    function _processLoopAction(SeatType _seatType, bytes32 _actionHash) private returns (bool) {
        // This would contain the actual business logic for each seat type
        // For now, we simulate successful execution
        return true;
    }

    /**
     * @notice Update department strategy
     * @param _seatType Type of seat
     * @param _strategy New strategy string
     */
    function updateStrategy(SeatType _seatType, string calldata _strategy) 
        external 
        onlySeatHolder(_seatType) 
        onlyActiveSeat(_seatType) 
    {
        departments[_seatType].strategy = _strategy;
        emit StrategyUpdated(_seatType, _strategy, block.timestamp);
    }

    /**
     * @notice Update department tooling
     * @param _seatType Type of seat
     * @param _tooling New tooling string
     */
    function updateTooling(SeatType _seatType, string calldata _tooling) 
        external 
        onlySeatHolder(_seatType) 
        onlyActiveSeat(_seatType) 
    {
        departments[_seatType].tooling = _tooling;
        emit ToolingUpdated(_seatType, _tooling, block.timestamp);
    }

    /**
     * @notice Report revenue for a seat
     * @param _seatType Type of seat
     * @param _amount Revenue amount
     */
    function reportRevenue(SeatType _seatType, uint256 _amount) 
        external 
        onlySeatHolder(_seatType) 
        onlyActiveSeat(_seatType) 
    {
        departments[_seatType].totalRevenue += _amount;
        emit RevenueReported(_seatType, _amount, block.timestamp);
    }

    /**
     * @notice Report expenses for a seat
     * @param _seatType Type of seat
     * @param _amount Expense amount
     */
    function reportExpense(SeatType _seatType, uint256 _amount) 
        external 
        onlySeatHolder(_seatType) 
        onlyActiveSeat(_seatType) 
    {
        departments[_seatType].totalExpenses += _amount;
        emit ExpenseReported(_seatType, _amount, block.timestamp);
    }

    /**
     * @notice Suspend a seat (Publisher action)
     * @param _seatType Type of seat to suspend
     */
    function suspendSeat(SeatType _seatType) external onlyPublisher onlyActiveSeat(_seatType) {
        departments[_seatType].status = SeatStatus.Suspended;
        emit SeatSuspended(_seatType, block.timestamp);
    }

    /**
     * @notice Reactivate a suspended seat
     * @param _seatType Type of seat to reactivate
     */
    function reactivateSeat(SeatType _seatType) external onlyPublisher {
        require(departments[_seatType].status == SeatStatus.Suspended, "Seat is not suspended");
        departments[_seatType].status = SeatStatus.Filled;
        emit SeatReactivated(_seatType, block.timestamp);
    }

    /**
     * @notice Set loop interval for a seat
     * @param _seatType Type of seat
     * @param _interval New loop interval in seconds
     */
    function setLoopInterval(SeatType _seatType, uint256 _interval) 
        external 
        onlySeatHolder(_seatType) 
        onlyActiveSeat(_seatType) 
    {
        require(_interval >= 1 minutes, "Interval too short");
        departments[_seatType].loopInterval = _interval;
    }

    /**
     * @notice Get department details
     * @param _seatType Type of seat
     * @return Department struct
     */
    function getDepartment(SeatType _seatType) external view returns (Department memory) {
        return departments[_seatType];
    }

    /**
     * @notice Get loop execution history for a seat
     * @param _seatType Type of seat
     * @return Array of LoopExecution
     */
    function getLoopHistory(SeatType _seatType) external view returns (LoopExecution[] memory) {
        return loopHistory[_seatType];
    }

    /**
     * @notice Get all seats held by an address
     * @param _holder Address of the holder
     * @return Array of SeatType
     */
    function getHolderSeats(address _holder) external view returns (SeatType[] memory) {
        return holderSeats[_holder];
    }

    /**
     * @notice Internal function to remove a seat from holder's list
     */
    function _removeHolderSeat(address _holder, SeatType _seatType) private {
        SeatType[] storage seats = holderSeats[_holder];
        for (uint256 i = 0; i < seats.length; i++) {
            if (seats[i] == _seatType) {
                seats[i] = seats[seats.length - 1];
                seats.pop();
                break;
            }
        }
    }

    /**
     * @notice Get seat profitability (revenue - expenses)
     * @param _seatType Type of seat
     * @return Profit/Loss amount
     */
    function getSeatProfitability(SeatType _seatType) external view returns (int256) {
        Department storage dept = departments[_seatType];
        return int256(dept.totalRevenue) - int256(dept.totalExpenses);
    }

    /**
     * @notice Check if a seat is due for loop execution
     * @param _seatType Type of seat
     * @return bool Whether loop is due
     */
    function isLoopDue(SeatType _seatType) external view returns (bool) {
        Department storage dept = departments[_seatType];
        return block.timestamp >= dept.lastLoopExecution + dept.loopInterval;
    }

    /**
     * @notice Get all vacant seats
     * @return Array of vacant SeatType
     */
    function getVacantSeats() external view returns (SeatType[] memory) {
        SeatType[] memory vacant = new SeatType[](4);
        uint256 count = 0;
        
        for (uint256 i = 0; i < 4; i++) {
            SeatType st = SeatType(i);
            if (departments[st].status == SeatStatus.Vacant) {
                vacant[count] = st;
                count++;
            }
        }
        
        // Resize array
        assembly {
            mstore(vacant, count)
        }
        
        return vacant;
    }

    /**
     * @notice Fallback function to receive ETH
     */
    receive() external payable {
        // Treasury seat handles ETH
        if (departments[SeatType.Treasury].status == SeatStatus.Filled) {
            departments[SeatType.Treasury].totalRevenue += msg.value;
        }
    }
}
