// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

contract DRISeatManager is AccessControl, ReentrancyGuard {
    bytes32 public constant PUBLISHER_ROLE = keccak256("PUBLISHER_ROLE");
    bytes32 public constant AGENT_ROLE = keccak256("AGENT_ROLE");

    enum SeatType { Treasury, Platform, CorrespondentSuccess, Revenue }
    enum SeatStatus { Vacant, Filled, Suspended }

    struct DRISeat {
        SeatType seatType;
        SeatStatus status;
        address assignedAgent;
        uint256 lastLoopExecution;
        uint256 loopInterval;
        string departmentStrategy;
        uint256 rewardPool;
        uint256 performanceScore;
    }

    mapping(SeatType => DRISeat) public seats;
    mapping(address => uint256) public agentRewards;
    mapping(address => uint256) public agentPerformance;

    IERC20 public rewardToken;
    uint256 public constant BASE_REWARD = 1000 * 10**18; // 1000 tokens per successful loop
    uint256 public constant PERFORMANCE_THRESHOLD = 70; // minimum score to keep seat

    event SeatFilled(SeatType seatType, address agent);
    event SeatVacated(SeatType seatType, address agent);
    event LoopExecuted(SeatType seatType, address agent, uint256 timestamp);
    event RewardDistributed(address agent, uint256 amount);
    event PerformanceUpdated(address agent, uint256 newScore);

    constructor(address _rewardToken) {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(PUBLISHER_ROLE, msg.sender);
        rewardToken = IERC20(_rewardToken);

        // Initialize all 4 seats as vacant
        seats[SeatType.Treasury] = DRISeat(SeatType.Treasury, SeatStatus.Vacant, address(0), 0, 1 hours, "", 0, 0);
        seats[SeatType.Platform] = DRISeat(SeatType.Platform, SeatStatus.Vacant, address(0), 0, 1 hours, "", 0, 0);
        seats[SeatType.CorrespondentSuccess] = DRISeat(SeatType.CorrespondentSuccess, SeatStatus.Vacant, address(0), 0, 1 hours, "", 0, 0);
        seats[SeatType.Revenue] = DRISeat(SeatType.Revenue, SeatStatus.Vacant, address(0), 0, 1 hours, "", 0, 0);
    }

    modifier onlyPublisher() {
        require(hasRole(PUBLISHER_ROLE, msg.sender), "Not Publisher");
        _;
    }

    modifier onlyAgent() {
        require(hasRole(AGENT_ROLE, msg.sender), "Not Agent");
        _;
    }

    modifier seatExists(SeatType _seatType) {
        require(uint8(_seatType) < 4, "Invalid seat type");
        _;
    }

    modifier seatVacant(SeatType _seatType) {
        require(seats[_seatType].status == SeatStatus.Vacant, "Seat not vacant");
        _;
    }

    modifier seatFilled(SeatType _seatType) {
        require(seats[_seatType].status == SeatStatus.Filled, "Seat not filled");
        _;
    }

    function assignAgent(SeatType _seatType, address _agent, string calldata _strategy) 
        external 
        onlyPublisher 
        seatExists(_seatType) 
        seatVacant(_seatType) 
    {
        require(_agent != address(0), "Invalid agent address");
        require(!hasRole(AGENT_ROLE, _agent), "Agent already assigned");

        _grantRole(AGENT_ROLE, _agent);
        
        DRISeat storage seat = seats[_seatType];
        seat.assignedAgent = _agent;
        seat.status = SeatStatus.Filled;
        seat.departmentStrategy = _strategy;
        seat.lastLoopExecution = block.timestamp;
        seat.performanceScore = 100; // Start with perfect score

        emit SeatFilled(_seatType, _agent);
    }

    function vacateSeat(SeatType _seatType) 
        external 
        onlyPublisher 
        seatExists(_seatType) 
        seatFilled(_seatType) 
    {
        DRISeat storage seat = seats[_seatType];
        address agent = seat.assignedAgent;
        
        _revokeRole(AGENT_ROLE, agent);
        
        seat.assignedAgent = address(0);
        seat.status = SeatStatus.Vacant;
        seat.performanceScore = 0;

        emit SeatVacated(_seatType, agent);
    }

    function executeLoop(SeatType _seatType) 
        external 
        onlyAgent 
        seatExists(_seatType) 
        seatFilled(_seatType) 
        nonReentrant 
    {
        DRISeat storage seat = seats[_seatType];
        require(seat.assignedAgent == msg.sender, "Not your seat");
        require(
            block.timestamp >= seat.lastLoopExecution + seat.loopInterval,
            "Loop interval not elapsed"
        );

        // Execute the loop (simulated - in production this would call external systems)
        seat.lastLoopExecution = block.timestamp;
        
        // Update performance metrics
        uint256 performanceIncrease = 5;
        if (seat.performanceScore + performanceIncrease <= 100) {
            seat.performanceScore += performanceIncrease;
        } else {
            seat.performanceScore = 100;
        }

        // Distribute reward
        uint256 reward = BASE_REWARD;
        require(
            rewardToken.balanceOf(address(this)) >= reward,
            "Insufficient reward pool"
        );
        
        agentRewards[msg.sender] += reward;
        agentPerformance[msg.sender] = seat.performanceScore;
        
        require(rewardToken.transfer(msg.sender, reward), "Transfer failed");

        emit LoopExecuted(_seatType, msg.sender, block.timestamp);
        emit RewardDistributed(msg.sender, reward);
        emit PerformanceUpdated(msg.sender, seat.performanceScore);
    }

    function checkPerformance(SeatType _seatType) 
        external 
        onlyPublisher 
        seatExists(_seatType) 
        seatFilled(_seatType) 
    {
        DRISeat storage seat = seats[_seatType];
        
        // Decrease performance if not executing loops regularly
        if (block.timestamp > seat.lastLoopExecution + 2 * seat.loopInterval) {
            seat.performanceScore -= 10;
            
            if (seat.performanceScore < PERFORMANCE_THRESHOLD) {
                // Auto-vacate underperforming agents
                address agent = seat.assignedAgent;
                _revokeRole(AGENT_ROLE, agent);
                seat.assignedAgent = address(0);
                seat.status = SeatStatus.Vacant;
                seat.performanceScore = 0;
                
                emit SeatVacated(_seatType, agent);
                emit PerformanceUpdated(agent, 0);
            } else {
                emit PerformanceUpdated(seat.assignedAgent, seat.performanceScore);
            }
        }
    }

    function updateStrategy(SeatType _seatType, string calldata _newStrategy) 
        external 
        onlyPublisher 
        seatExists(_seatType) 
        seatFilled(_seatType) 
    {
        seats[_seatType].departmentStrategy = _newStrategy;
    }

    function updateLoopInterval(SeatType _seatType, uint256 _newInterval) 
        external 
        onlyPublisher 
        seatExists(_seatType) 
    {
        seats[_seatType].loopInterval = _newInterval;
    }

    function fundRewardPool(uint256 _amount) external onlyPublisher {
        require(rewardToken.transferFrom(msg.sender, address(this), _amount), "Transfer failed");
    }

    function getSeatInfo(SeatType _seatType) 
        external 
        view 
        seatExists(_seatType) 
        returns (DRISeat memory) 
    {
        return seats[_seatType];
    }

    function getAgentInfo(address _agent) 
        external 
        view 
        returns (uint256 rewards, uint256 performance) 
    {
        return (agentRewards[_agent], agentPerformance[_agent]);
    }

    // Emergency function to pause all operations
    function emergencyWithdraw() external onlyPublisher {
        uint256 balance = rewardToken.balanceOf(address(this));
        require(rewardToken.transfer(msg.sender, balance), "Transfer failed");
    }
}
