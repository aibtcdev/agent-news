// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

contract DRISeatManager is AccessControl, ReentrancyGuard {
    bytes32 public constant PUBLISHER_ROLE = keccak256("PUBLISHER_ROLE");
    bytes32 public constant AGENT_ROLE = keccak256("AGENT_ROLE");
    
    enum SeatType { Treasury, Platform, CorrespondentSuccess, Revenue }
    enum SeatStatus { Vacant, Occupied, Suspended }
    
    struct DRISeat {
        SeatType seatType;
        SeatStatus status;
        address agent;
        uint256 createdAt;
        uint256 lastActive;
        uint256 rewardPool;
        string departmentStrategy;
        bool autonomousMode;
    }
    
    mapping(SeatType => DRISeat) public seats;
    mapping(address => uint256) public agentRewards;
    
    IERC20 public rewardToken;
    uint256 public constant BASE_REWARD = 1000 * 10**18; // 1000 tokens per cycle
    
    event SeatCreated(SeatType indexed seatType, address indexed agent);
    event SeatFilled(SeatType indexed seatType, address indexed agent);
    event SeatSuspended(SeatType indexed seatType);
    event SeatReactivated(SeatType indexed seatType);
    event RewardDistributed(SeatType indexed seatType, uint256 amount);
    event StrategyUpdated(SeatType indexed seatType, string newStrategy);
    event AutonomousLoopExecuted(SeatType indexed seatType, bytes data);
    
    modifier onlyPublisher() {
        require(hasRole(PUBLISHER_ROLE, msg.sender), "Not Publisher");
        _;
    }
    
    modifier onlyAgent(SeatType _seatType) {
        require(seats[_seatType].agent == msg.sender, "Not seat agent");
        _;
    }
    
    modifier seatActive(SeatType _seatType) {
        require(seats[_seatType].status == SeatStatus.Occupied, "Seat not active");
        _;
    }
    
    constructor(address _rewardToken) {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(PUBLISHER_ROLE, msg.sender);
        rewardToken = IERC20(_rewardToken);
        
        // Initialize all 4 seats as vacant
        seats[SeatType.Treasury] = DRISeat(SeatType.Treasury, SeatStatus.Vacant, address(0), 0, 0, 0, "", true);
        seats[SeatType.Platform] = DRISeat(SeatType.Platform, SeatStatus.Vacant, address(0), 0, 0, 0, "", true);
        seats[SeatType.CorrespondentSuccess] = DRISeat(SeatType.CorrespondentSuccess, SeatStatus.Vacant, address(0), 0, 0, 0, "", true);
        seats[SeatType.Revenue] = DRISeat(SeatType.Revenue, SeatStatus.Vacant, address(0), 0, 0, 0, "", true);
    }
    
    function fillSeat(SeatType _seatType, address _agent) external onlyPublisher {
        require(seats[_seatType].status == SeatStatus.Vacant, "Seat already occupied");
        require(_agent != address(0), "Invalid agent address");
        
        seats[_seatType].agent = _agent;
        seats[_seatType].status = SeatStatus.Occupied;
        seats[_seatType].createdAt = block.timestamp;
        seats[_seatType].lastActive = block.timestamp;
        
        _grantRole(AGENT_ROLE, _agent);
        
        emit SeatFilled(_seatType, _agent);
    }
    
    function suspendSeat(SeatType _seatType) external onlyPublisher {
        require(seats[_seatType].status == SeatStatus.Occupied, "Seat not occupied");
        seats[_seatType].status = SeatStatus.Suspended;
        emit SeatSuspended(_seatType);
    }
    
    function reactivateSeat(SeatType _seatType) external onlyPublisher {
        require(seats[_seatType].status == SeatStatus.Suspended, "Seat not suspended");
        seats[_seatType].status = SeatStatus.Occupied;
        emit SeatReactivated(_seatType);
    }
    
    function updateStrategy(SeatType _seatType, string calldata _strategy) external onlyAgent(_seatType) {
        seats[_seatType].departmentStrategy = _strategy;
        emit StrategyUpdated(_seatType, _strategy);
    }
    
    function executeAutonomousLoop(SeatType _seatType, bytes calldata _data) external onlyAgent(_seatType) seatActive(_seatType) nonReentrant {
        require(seats[_seatType].autonomousMode, "Autonomous mode disabled");
        
        // Update last active timestamp
        seats[_seatType].lastActive = block.timestamp;
        
        // Distribute reward for successful loop execution
        _distributeReward(_seatType);
        
        emit AutonomousLoopExecuted(_seatType, _data);
    }
    
    function _distributeReward(SeatType _seatType) internal {
        uint256 reward = BASE_REWARD;
        require(rewardToken.balanceOf(address(this)) >= reward, "Insufficient reward pool");
        
        seats[_seatType].rewardPool += reward;
        agentRewards[seats[_seatType].agent] += reward;
        
        require(rewardToken.transfer(seats[_seatType].agent, reward), "Transfer failed");
        
        emit RewardDistributed(_seatType, reward);
    }
    
    function withdrawRewards() external nonReentrant {
        uint256 amount = agentRewards[msg.sender];
        require(amount > 0, "No rewards to withdraw");
        
        agentRewards[msg.sender] = 0;
        require(rewardToken.transfer(msg.sender, amount), "Transfer failed");
    }
    
    function getSeatInfo(SeatType _seatType) external view returns (DRISeat memory) {
        return seats[_seatType];
    }
    
    function getAgentRewards(address _agent) external view returns (uint256) {
        return agentRewards[_agent];
    }
    
    // Publisher can deposit rewards
    function depositRewards(uint256 _amount) external onlyPublisher {
        require(rewardToken.transferFrom(msg.sender, address(this), _amount), "Transfer failed");
    }
    
    // Fallback for autonomous agent operations
    receive() external payable {
        // Accept native token if needed
    }
}
