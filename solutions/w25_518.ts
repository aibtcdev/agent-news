// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/Counters.sol";

contract DRISeatManager is Ownable, ReentrancyGuard {
    using Counters for Counters.Counter;

    // Enums
    enum SeatStatus { Vacant, Filled, Suspended }
    enum SeatType { Treasury, Platform, CorrespondentSuccess, Revenue }

    // Structs
    struct DRISeat {
        uint256 id;
        SeatType seatType;
        SeatStatus status;
        address agentAddress;
        string departmentName;
        uint256 createdAt;
        uint256 lastActionTimestamp;
        uint256 performanceScore;
        uint256 rewardBalance;
    }

    struct Action {
        uint256 seatId;
        string actionType;
        string actionData;
        uint256 timestamp;
        bool executed;
    }

    // State variables
    mapping(uint256 => DRISeat) public seats;
    mapping(address => uint256) public agentToSeatId;
    mapping(uint256 => Action[]) public seatActions;
    
    Counters.Counter private _seatIds;
    Counters.Counter private _actionIds;

    uint256 public constant MAX_SEATS = 4;
    uint256 public constant REWARD_PER_ACTION = 10 ether; // 10 tokens per action
    uint256 public constant SUSPENSION_THRESHOLD = 3; // missed actions before suspension
    
    IERC20 public rewardToken;
    address public publisherAddress;
    
    // Events
    event SeatCreated(uint256 indexed seatId, SeatType seatType, address indexed agentAddress);
    event SeatFilled(uint256 indexed seatId, address indexed agentAddress);
    event SeatSuspended(uint256 indexed seatId, string reason);
    event ActionExecuted(uint256 indexed seatId, uint256 indexed actionId, string actionType);
    event RewardDistributed(uint256 indexed seatId, uint256 amount);
    event PerformanceUpdated(uint256 indexed seatId, uint256 newScore);

    // Modifiers
    modifier onlyPublisher() {
        require(msg.sender == publisherAddress, "Only Publisher can call this");
        _;
    }

    modifier onlyActiveSeat(uint256 seatId) {
        require(seats[seatId].status == SeatStatus.Filled, "Seat not active");
        _;
    }

    modifier onlySeatAgent(uint256 seatId) {
        require(msg.sender == seats[seatId].agentAddress, "Only seat agent can call this");
        _;
    }

    constructor(address _rewardToken, address _publisher) {
        require(_rewardToken != address(0), "Invalid token address");
        require(_publisher != address(0), "Invalid publisher address");
        
        rewardToken = IERC20(_rewardToken);
        publisherAddress = _publisher;
    }

    // Core functions
    function createSeat(SeatType seatType, address initialAgent) external onlyPublisher returns (uint256) {
        require(_seatIds.current() < MAX_SEATS, "Max seats reached");
        require(initialAgent != address(0), "Invalid agent address");
        require(agentToSeatId[initialAgent] == 0, "Agent already assigned");

        _seatIds.increment();
        uint256 newSeatId = _seatIds.current();

        seats[newSeatId] = DRISeat({
            id: newSeatId,
            seatType: seatType,
            status: SeatStatus.Filled,
            agentAddress: initialAgent,
            departmentName: getDepartmentName(seatType),
            createdAt: block.timestamp,
            lastActionTimestamp: block.timestamp,
            performanceScore: 100,
            rewardBalance: 0
        });

        agentToSeatId[initialAgent] = newSeatId;

        emit SeatCreated(newSeatId, seatType, initialAgent);
        emit SeatFilled(newSeatId, initialAgent);

        return newSeatId;
    }

    function executeAction(uint256 seatId, string memory actionType, string memory actionData) 
        external 
        onlyActiveSeat(seatId) 
        onlySeatAgent(seatId) 
        nonReentrant 
        returns (uint256)
    {
        _actionIds.increment();
        uint256 actionId = _actionIds.current();

        Action memory newAction = Action({
            seatId: seatId,
            actionType: actionType,
            actionData: actionData,
            timestamp: block.timestamp,
            executed: true
        });

        seatActions[seatId].push(newAction);
        
        // Update seat state
        seats[seatId].lastActionTimestamp = block.timestamp;
        seats[seatId].performanceScore = calculatePerformanceScore(seatId);
        
        // Distribute reward
        distributeReward(seatId);

        emit ActionExecuted(seatId, actionId, actionType);
        
        return actionId;
    }

    function distributeReward(uint256 seatId) internal {
        uint256 reward = REWARD_PER_ACTION;
        require(rewardToken.balanceOf(address(this)) >= reward, "Insufficient reward balance");
        
        seats[seatId].rewardBalance += reward;
        require(rewardToken.transfer(seats[seatId].agentAddress, reward), "Transfer failed");
        
        emit RewardDistributed(seatId, reward);
    }

    function suspendSeat(uint256 seatId, string memory reason) external onlyPublisher {
        require(seats[seatId].status == SeatStatus.Filled, "Seat not active");
        
        seats[seatId].status = SeatStatus.Suspended;
        agentToSeatId[seats[seatId].agentAddress] = 0;
        
        emit SeatSuspended(seatId, reason);
    }

    function replaceAgent(uint256 seatId, address newAgent) external onlyPublisher {
        require(seats[seatId].status != SeatStatus.Vacant, "Seat is vacant");
        require(newAgent != address(0), "Invalid agent address");
        require(agentToSeatId[newAgent] == 0, "Agent already assigned");
        
        // Clear old agent mapping
        agentToSeatId[seats[seatId].agentAddress] = 0;
        
        // Update seat
        seats[seatId].agentAddress = newAgent;
        seats[seatId].status = SeatStatus.Filled;
        seats[seatId].lastActionTimestamp = block.timestamp;
        
        agentToSeatId[newAgent] = seatId;
        
        emit SeatFilled(seatId, newAgent);
    }

    // View functions
    function getSeatDetails(uint256 seatId) external view returns (DRISeat memory) {
        require(seatId > 0 && seatId <= _seatIds.current(), "Invalid seat ID");
        return seats[seatId];
    }

    function getSeatActions(uint256 seatId) external view returns (Action[] memory) {
        return seatActions[seatId];
    }

    function getAgentSeat(address agent) external view returns (uint256) {
        return agentToSeatId[agent];
    }

    function calculatePerformanceScore(uint256 seatId) public view returns (uint256) {
        DRISeat storage seat = seats[seatId];
        uint256 timeSinceLastAction = block.timestamp - seat.lastActionTimestamp;
        
        // Base score decreases over time without actions
        uint256 baseScore = 100;
        uint256 timePenalty = timeSinceLastAction / 1 days; // 1 point per day
        
        if (timePenalty > baseScore) {
            return 0;
        }
        
        return baseScore - timePenalty;
    }

    function getDepartmentName(SeatType seatType) internal pure returns (string memory) {
        if (seatType == SeatType.Treasury) return "Treasury Department";
        if (seatType == SeatType.Platform) return "Platform Department";
        if (seatType == SeatType.CorrespondentSuccess) return "Correspondent Success Department";
        if (seatType == SeatType.Revenue) return "Revenue Department";
        return "Unknown";
    }

    // Admin functions
    function setRewardToken(address newToken) external onlyOwner {
        require(newToken != address(0), "Invalid token address");
        rewardToken = IERC20(newToken);
    }

    function setPublisherAddress(address newPublisher) external onlyOwner {
        require(newPublisher != address(0), "Invalid publisher address");
        publisherAddress = newPublisher;
    }

    function withdrawTokens(address token, uint256 amount) external onlyOwner {
        IERC20(token).transfer(owner(), amount);
    }

    // Fallback
    receive() external payable {
        // Accept ETH for gas or rewards
    }
}
