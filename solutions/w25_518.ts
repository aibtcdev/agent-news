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
    bytes32 public constant AGENT_ROLE = keccak256("AGENT_ROLE");

    // Seat types
    enum SeatType { Treasury, Platform, CorrespondentSuccess, Revenue }

    // Department structure
    struct Department {
        SeatType seatType;
        address agent;
        bool active;
        uint256 lastLoopExecution;
        uint256 loopInterval;
        bytes32 strategyHash;
        string metadata;
    }

    // Loop execution record
    struct LoopRecord {
        uint256 timestamp;
        bytes32 actionHash;
        bool success;
        string result;
    }

    // Mapping from seat type to department
    mapping(SeatType => Department) public departments;
    
    // Loop history for each department
    mapping(SeatType => LoopRecord[]) public loopHistory;
    
    // Token for rewards (if any)
    IERC20 public rewardToken;
    
    // Events
    event SeatCreated(SeatType indexed seatType, address indexed agent, uint256 timestamp);
    event SeatRemoved(SeatType indexed seatType, uint256 timestamp);
    event LoopExecuted(SeatType indexed seatType, bytes32 actionHash, bool success, uint256 timestamp);
    event StrategyUpdated(SeatType indexed seatType, bytes32 newStrategyHash, uint256 timestamp);
    event RewardDistributed(SeatType indexed seatType, address indexed agent, uint256 amount);

    constructor(address _publisher, address _rewardToken) {
        _grantRole(PUBLISHER_ROLE, _publisher);
        _grantRole(DEFAULT_ADMIN_ROLE, _publisher);
        rewardToken = IERC20(_rewardToken);
    }

    modifier onlyPublisher() {
        require(hasRole(PUBLISHER_ROLE, msg.sender), "Caller is not Publisher");
        _;
    }

    modifier onlyAgent(SeatType _seatType) {
        require(departments[_seatType].agent == msg.sender, "Caller is not the seat agent");
        _;
    }

    modifier seatExists(SeatType _seatType) {
        require(departments[_seatType].active, "Seat does not exist");
        _;
    }

    /**
     * @notice Create a new DRI seat
     * @param _seatType Type of seat to create
     * @param _agent Address of the autonomous agent
     * @param _loopInterval Time between loop executions (in seconds)
     * @param _strategyHash Initial strategy hash
     * @param _metadata Additional metadata
     */
    function createSeat(
        SeatType _seatType,
        address _agent,
        uint256 _loopInterval,
        bytes32 _strategyHash,
        string calldata _metadata
    ) external onlyPublisher {
        require(!departments[_seatType].active, "Seat already exists");
        require(_agent != address(0), "Invalid agent address");
        require(_loopInterval > 0, "Loop interval must be > 0");

        departments[_seatType] = Department({
            seatType: _seatType,
            agent: _agent,
            active: true,
            lastLoopExecution: block.timestamp,
            loopInterval: _loopInterval,
            strategyHash: _strategyHash,
            metadata: _metadata
        });

        _grantRole(AGENT_ROLE, _agent);
        emit SeatCreated(_seatType, _agent, block.timestamp);
    }

    /**
     * @notice Remove a DRI seat
     * @param _seatType Seat to remove
     */
    function removeSeat(SeatType _seatType) external onlyPublisher seatExists(_seatType) {
        address agent = departments[_seatType].agent;
        departments[_seatType].active = false;
        _revokeRole(AGENT_ROLE, agent);
        emit SeatRemoved(_seatType, block.timestamp);
    }

    /**
     * @notice Execute a loop for a specific seat
     * @param _seatType Seat executing the loop
     * @param _actionHash Hash of the action being performed
     * @param _success Whether the action was successful
     * @param _result Description of the result
     */
    function executeLoop(
        SeatType _seatType,
        bytes32 _actionHash,
        bool _success,
        string calldata _result
    ) external onlyAgent(_seatType) seatExists(_seatType) {
        Department storage dept = departments[_seatType];
        require(
            block.timestamp >= dept.lastLoopExecution + dept.loopInterval,
            "Loop interval not elapsed"
        );

        dept.lastLoopExecution = block.timestamp;
        
        loopHistory[_seatType].push(LoopRecord({
            timestamp: block.timestamp,
            actionHash: _actionHash,
            success: _success,
            result: _result
        }));

        emit LoopExecuted(_seatType, _actionHash, _success, block.timestamp);
    }

    /**
     * @notice Update department strategy
     * @param _seatType Seat to update
     * @param _newStrategyHash New strategy hash
     */
    function updateStrategy(
        SeatType _seatType,
        bytes32 _newStrategyHash
    ) external onlyAgent(_seatType) seatExists(_seatType) {
        departments[_seatType].strategyHash = _newStrategyHash;
        emit StrategyUpdated(_seatType, _newStrategyHash, block.timestamp);
    }

    /**
     * @notice Distribute rewards to a seat agent
     * @param _seatType Seat to reward
     * @param _amount Amount of reward tokens
     */
    function distributeReward(
        SeatType _seatType,
        uint256 _amount
    ) external onlyPublisher seatExists(_seatType) {
        require(_amount > 0, "Amount must be > 0");
        require(
            rewardToken.transfer(departments[_seatType].agent, _amount),
            "Transfer failed"
        );
        emit RewardDistributed(_seatType, departments[_seatType].agent, _amount);
    }

    /**
     * @notice Get loop history for a seat
     * @param _seatType Seat to query
     * @return Array of loop records
     */
    function getLoopHistory(SeatType _seatType) external view returns (LoopRecord[] memory) {
        return loopHistory[_seatType];
    }

    /**
     * @notice Get department details
     * @param _seatType Seat to query
     * @return Department struct
     */
    function getDepartment(SeatType _seatType) external view returns (Department memory) {
        return departments[_seatType];
    }

    /**
     * @notice Check if a seat is ready for loop execution
     * @param _seatType Seat to check
     * @return bool Whether the seat can execute its loop
     */
    function canExecuteLoop(SeatType _seatType) external view seatExists(_seatType) returns (bool) {
        Department memory dept = departments[_seatType];
        return block.timestamp >= dept.lastLoopExecution + dept.loopInterval;
    }

    /**
     * @notice Update loop interval for a seat
     * @param _seatType Seat to update
     * @param _newInterval New interval in seconds
     */
    function updateLoopInterval(
        SeatType _seatType,
        uint256 _newInterval
    ) external onlyPublisher seatExists(_seatType) {
        require(_newInterval > 0, "Interval must be > 0");
        departments[_seatType].loopInterval = _newInterval;
    }

    /**
     * @notice Transfer publisher role to new address
     * @param _newPublisher New publisher address
     */
    function transferPublisher(address _newPublisher) external onlyPublisher {
        require(_newPublisher != address(0), "Invalid address");
        _grantRole(PUBLISHER_ROLE, _newPublisher);
        _revokeRole(PUBLISHER_ROLE, msg.sender);
    }
}
