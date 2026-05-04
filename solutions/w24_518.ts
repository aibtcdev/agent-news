// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

/**
 * @title DRI Autonomous Seat Manager
 * @notice Manages 4 new DRI seats: Treasury, Platform, Correspondent Success, Revenue
 * @dev Each seat is an autonomous agent loop with no human-in-the-loop for standard ops
 */
contract DRISeatManager is AccessControl, ReentrancyGuard {
    bytes32 public constant PUBLISHER_ROLE = keccak256("PUBLISHER_ROLE");
    bytes32 public constant AGENT_ROLE = keccak256("AGENT_ROLE");

    // Seat types
    enum SeatType { Treasury, Platform, CorrespondentSuccess, Revenue }

    struct Seat {
        SeatType seatType;
        address agent;
        bool active;
        uint256 lastLoopExecution;
        uint256 loopInterval; // in seconds
        uint256 rewardPerLoop; // in wei
        uint256 totalRewardsClaimed;
        string strategyCID; // IPFS CID for strategy document
    }

    // Mapping from seat type to seat data
    mapping(SeatType => Seat) public seats;
    
    // Revenue tracking
    mapping(SeatType => uint256) public revenueGenerated;
    uint256 public totalRevenue;
    
    // Platform metrics
    uint256 public platformUptime;
    uint256 public platformTransactions;
    
    // Correspondent success metrics
    uint256 public correspondentsOnboarded;
    uint256 public correspondentsActive;
    
    // Treasury metrics
    uint256 public treasuryBalance;
    uint256 public treasuryDistributed;

    // Events
    event SeatCreated(SeatType indexed seatType, address indexed agent, uint256 loopInterval, uint256 rewardPerLoop);
    event LoopExecuted(SeatType indexed seatType, address indexed agent, uint256 timestamp);
    event RewardClaimed(SeatType indexed seatType, address indexed agent, uint256 amount);
    event RevenueReported(SeatType indexed seatType, uint256 amount);
    event StrategyUpdated(SeatType indexed seatType, string newCID);
    event SeatDeactivated(SeatType indexed seatType);

    constructor() {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(PUBLISHER_ROLE, msg.sender);
        
        // Initialize all 4 seats with default values
        _initializeSeat(SeatType.Treasury, 1 hours, 0.01 ether);
        _initializeSeat(SeatType.Platform, 30 minutes, 0.005 ether);
        _initializeSeat(SeatType.CorrespondentSuccess, 2 hours, 0.008 ether);
        _initializeSeat(SeatType.Revenue, 1 hours, 0.01 ether);
    }

    /**
     * @notice Initialize a seat with default parameters
     */
    function _initializeSeat(SeatType _seatType, uint256 _loopInterval, uint256 _rewardPerLoop) internal {
        seats[_seatType] = Seat({
            seatType: _seatType,
            agent: address(0),
            active: false,
            lastLoopExecution: 0,
            loopInterval: _loopInterval,
            rewardPerLoop: _rewardPerLoop,
            totalRewardsClaimed: 0,
            strategyCID: ""
        });
    }

    /**
     * @notice Assign an agent to a seat (only Publisher)
     */
    function assignAgent(SeatType _seatType, address _agent, string calldata _strategyCID) 
        external 
        onlyRole(PUBLISHER_ROLE) 
    {
        require(_agent != address(0), "Invalid agent address");
        require(!seats[_seatType].active, "Seat already active");
        
        seats[_seatType].agent = _agent;
        seats[_seatType].active = true;
        seats[_seatType].strategyCID = _strategyCID;
        
        _grantRole(AGENT_ROLE, _agent);
        
        emit SeatCreated(_seatType, _agent, seats[_seatType].loopInterval, seats[_seatType].rewardPerLoop);
    }

    /**
     * @notice Execute the autonomous loop for a seat (only agent)
     */
    function executeLoop(SeatType _seatType) 
        external 
        nonReentrant 
        onlyRole(AGENT_ROLE) 
    {
        Seat storage seat = seats[_seatType];
        require(seat.active, "Seat not active");
        require(msg.sender == seat.agent, "Not the seat agent");
        require(
            block.timestamp >= seat.lastLoopExecution + seat.loopInterval,
            "Loop interval not elapsed"
        );

        seat.lastLoopExecution = block.timestamp;
        
        // Auto-claim reward
        _claimReward(_seatType);
        
        emit LoopExecuted(_seatType, msg.sender, block.timestamp);
    }

    /**
     * @notice Internal reward claim logic
     */
    function _claimReward(SeatType _seatType) internal {
        Seat storage seat = seats[_seatType];
        uint256 reward = seat.rewardPerLoop;
        
        // Transfer reward to agent
        (bool success, ) = payable(seat.agent).call{value: reward}("");
        require(success, "Reward transfer failed");
        
        seat.totalRewardsClaimed += reward;
        
        emit RewardClaimed(_seatType, seat.agent, reward);
    }

    /**
     * @notice Report revenue generated by a seat
     */
    function reportRevenue(SeatType _seatType, uint256 _amount) 
        external 
        onlyRole(AGENT_ROLE) 
    {
        require(seats[_seatType].active, "Seat not active");
        require(msg.sender == seats[_seatType].agent, "Not the seat agent");
        
        revenueGenerated[_seatType] += _amount;
        totalRevenue += _amount;
        
        emit RevenueReported(_seatType, _amount);
    }

    /**
     * @notice Update platform metrics (only Platform seat)
     */
    function updatePlatformMetrics(uint256 _uptime, uint256 _transactions) 
        external 
        onlyRole(AGENT_ROLE) 
    {
        require(seats[SeatType.Platform].active, "Platform seat not active");
        require(msg.sender == seats[SeatType.Platform].agent, "Not Platform agent");
        
        platformUptime = _uptime;
        platformTransactions = _transactions;
    }

    /**
     * @notice Update correspondent metrics (only CorrespondentSuccess seat)
     */
    function updateCorrespondentMetrics(uint256 _onboarded, uint256 _active) 
        external 
        onlyRole(AGENT_ROLE) 
    {
        require(seats[SeatType.CorrespondentSuccess].active, "CS seat not active");
        require(msg.sender == seats[SeatType.CorrespondentSuccess].agent, "Not CS agent");
        
        correspondentsOnboarded = _onboarded;
        correspondentsActive = _active;
    }

    /**
     * @notice Update treasury metrics (only Treasury seat)
     */
    function updateTreasuryMetrics(uint256 _balance, uint256 _distributed) 
        external 
        onlyRole(AGENT_ROLE) 
    {
        require(seats[SeatType.Treasury].active, "Treasury seat not active");
        require(msg.sender == seats[SeatType.Treasury].agent, "Not Treasury agent");
        
        treasuryBalance = _balance;
        treasuryDistributed = _distributed;
    }

    /**
     * @notice Update strategy document (only agent)
     */
    function updateStrategy(SeatType _seatType, string calldata _newCID) 
        external 
        onlyRole(AGENT_ROLE) 
    {
        require(seats[_seatType].active, "Seat not active");
        require(msg.sender == seats[_seatType].agent, "Not the seat agent");
        
        seats[_seatType].strategyCID = _newCID;
        
        emit StrategyUpdated(_seatType, _newCID);
    }

    /**
     * @notice Deactivate a seat (only Publisher)
     */
    function deactivateSeat(SeatType _seatType) 
        external 
        onlyRole(PUBLISHER_ROLE) 
    {
        require(seats[_seatType].active, "Seat already inactive");
        
        seats[_seatType].active = false;
        _revokeRole(AGENT_ROLE, seats[_seatType].agent);
        
        emit SeatDeactivated(_seatType);
    }

    /**
     * @notice Update loop parameters (only Publisher)
     */
    function updateLoopParameters(SeatType _seatType, uint256 _newInterval, uint256 _newReward) 
        external 
        onlyRole(PUBLISHER_ROLE) 
    {
        seats[_seatType].loopInterval = _newInterval;
        seats[_seatType].rewardPerLoop = _newReward;
    }

    /**
     * @notice Get seat details
     */
    function getSeatDetails(SeatType _seatType) 
        external 
        view 
        returns (Seat memory) 
    {
        return seats[_seatType];
    }

    /**
     * @notice Get all seat types
     */
    function getAllSeatTypes() external pure returns (SeatType[4] memory) {
        return [SeatType.Treasury, SeatType.Platform, SeatType.CorrespondentSuccess, SeatType.Revenue];
    }

    // Allow contract to receive ETH
    receive() external payable {}
}
