// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract DRISeatManager is Ownable, ReentrancyGuard {
    // Seat types
    enum SeatType { Treasury, Platform, CorrespondentSuccess, Revenue }
    
    // Seat status
    enum SeatStatus { Vacant, Filled, Suspended }
    
    // Agent structure
    struct Agent {
        address agentAddress;
        string name;
        string strategyHash; // IPFS hash of strategy document
        uint256 assignedAt;
        uint256 lastActive;
        bool isActive;
    }
    
    // Department structure
    struct Department {
        SeatType seatType;
        SeatStatus status;
        address currentAgent;
        uint256 seatId;
        uint256 createdAt;
        uint256 lastLoopExecution;
        uint256 loopCount;
        mapping(uint256 => LoopExecution) loopHistory;
    }
    
    // Loop execution record
    struct LoopExecution {
        uint256 timestamp;
        string actionHash;
        bool success;
        string resultHash;
    }
    
    // Publisher address
    address public publisher;
    
    // Token for rewards
    IERC20 public rewardToken;
    
    // Seat configurations
    mapping(SeatType => uint256) public seatIds;
    mapping(uint256 => Department) public departments;
    mapping(address => Agent) public agents;
    
    // Events
    event SeatFilled(SeatType seatType, address agent, uint256 seatId);
    event SeatVacated(SeatType seatType, address agent);
    event LoopExecuted(uint256 seatId, uint256 loopNumber, bool success);
    event StrategyUpdated(uint256 seatId, string newStrategyHash);
    event RewardDistributed(address agent, uint256 amount);
    
    // Constants
    uint256 public constant LOOP_INTERVAL = 1 hours;
    uint256 public constant REWARD_PER_LOOP = 10 * 10**18; // 10 tokens
    
    constructor(address _publisher, address _rewardToken) {
        publisher = _publisher;
        rewardToken = IERC20(_rewardToken);
        
        // Initialize 4 seats
        _initializeSeat(SeatType.Treasury);
        _initializeSeat(SeatType.Platform);
        _initializeSeat(SeatType.CorrespondentSuccess);
        _initializeSeat(SeatType.Revenue);
    }
    
    function _initializeSeat(SeatType _seatType) internal {
        uint256 seatId = uint256(keccak256(abi.encodePacked(_seatType, block.timestamp)));
        seatIds[_seatType] = seatId;
        
        Department storage dept = departments[seatId];
        dept.seatType = _seatType;
        dept.status = SeatStatus.Vacant;
        dept.seatId = seatId;
        dept.createdAt = block.timestamp;
        dept.loopCount = 0;
    }
    
    // Assign agent to seat (only publisher)
    function assignAgent(
        SeatType _seatType,
        address _agentAddress,
        string memory _name,
        string memory _strategyHash
    ) external onlyOwner {
        require(_agentAddress != address(0), "Invalid agent address");
        require(agents[_agentAddress].isActive == false, "Agent already assigned");
        
        uint256 seatId = seatIds[_seatType];
        Department storage dept = departments[seatId];
        require(dept.status == SeatStatus.Vacant, "Seat already filled");
        
        // Create agent
        agents[_agentAddress] = Agent({
            agentAddress: _agentAddress,
            name: _name,
            strategyHash: _strategyHash,
            assignedAt: block.timestamp,
            lastActive: block.timestamp,
            isActive: true
        });
        
        // Update department
        dept.currentAgent = _agentAddress;
        dept.status = SeatStatus.Filled;
        
        emit SeatFilled(_seatType, _agentAddress, seatId);
    }
    
    // Execute autonomous loop (called by agent or automation)
    function executeLoop(
        SeatType _seatType,
        string memory _actionHash,
        string memory _resultHash
    ) external nonReentrant {
        uint256 seatId = seatIds[_seatType];
        Department storage dept = departments[seatId];
        
        require(dept.status == SeatStatus.Filled, "Seat not filled");
        require(
            msg.sender == dept.currentAgent || msg.sender == publisher,
            "Unauthorized"
        );
        require(
            block.timestamp >= dept.lastLoopExecution + LOOP_INTERVAL,
            "Loop interval not elapsed"
        );
        
        // Record loop execution
        uint256 loopNumber = dept.loopCount;
        dept.loopHistory[loopNumber] = LoopExecution({
            timestamp: block.timestamp,
            actionHash: _actionHash,
            success: true,
            resultHash: _resultHash
        });
        
        dept.loopCount++;
        dept.lastLoopExecution = block.timestamp;
        
        // Update agent activity
        agents[dept.currentAgent].lastActive = block.timestamp;
        
        // Distribute reward
        _distributeReward(dept.currentAgent);
        
        emit LoopExecuted(seatId, loopNumber, true);
    }
    
    // Distribute reward to agent
    function _distributeReward(address _agent) internal {
        require(
            rewardToken.balanceOf(address(this)) >= REWARD_PER_LOOP,
            "Insufficient rewards"
        );
        
        rewardToken.transfer(_agent, REWARD_PER_LOOP);
        emit RewardDistributed(_agent, REWARD_PER_LOOP);
    }
    
    // Update strategy (agent or publisher)
    function updateStrategy(
        SeatType _seatType,
        string memory _newStrategyHash
    ) external {
        uint256 seatId = seatIds[_seatType];
        Department storage dept = departments[seatId];
        
        require(
            msg.sender == dept.currentAgent || msg.sender == publisher,
            "Unauthorized"
        );
        
        agents[dept.currentAgent].strategyHash = _newStrategyHash;
        emit StrategyUpdated(seatId, _newStrategyHash);
    }
    
    // Vacate seat (agent resignation or publisher removal)
    function vacateSeat(SeatType _seatType) external {
        uint256 seatId = seatIds[_seatType];
        Department storage dept = departments[seatId];
        
        require(
            msg.sender == dept.currentAgent || msg.sender == publisher,
            "Unauthorized"
        );
        
        address agentAddress = dept.currentAgent;
        
        // Deactivate agent
        agents[agentAddress].isActive = false;
        
        // Update department
        dept.currentAgent = address(0);
        dept.status = SeatStatus.Vacant;
        
        emit SeatVacated(_seatType, agentAddress);
    }
    
    // Get department info
    function getDepartmentInfo(SeatType _seatType) external view returns (
        SeatStatus status,
        address currentAgent,
        uint256 loopCount,
        uint256 lastLoopExecution
    ) {
        uint256 seatId = seatIds[_seatType];
        Department storage dept = departments[seatId];
        
        return (
            dept.status,
            dept.currentAgent,
            dept.loopCount,
            dept.lastLoopExecution
        );
    }
    
    // Get agent info
    function getAgentInfo(address _agent) external view returns (
        string memory name,
        string memory strategyHash,
        uint256 assignedAt,
        uint256 lastActive,
        bool isActive
    ) {
        Agent storage agent = agents[_agent];
        return (
            agent.name,
            agent.strategyHash,
            agent.assignedAt,
            agent.lastActive,
            agent.isActive
        );
    }
    
    // Get loop execution history
    function getLoopExecution(
        SeatType _seatType,
        uint256 _loopNumber
    ) external view returns (
        uint256 timestamp,
        string memory actionHash,
        bool success,
        string memory resultHash
    ) {
        uint256 seatId = seatIds[_seatType];
        Department storage dept = departments[seatId];
        LoopExecution storage loop = dept.loopHistory[_loopNumber];
        
        return (
            loop.timestamp,
            loop.actionHash,
            loop.success,
            loop.resultHash
        );
    }
    
    // Fund rewards contract
    function fundRewards(uint256 _amount) external onlyOwner {
        rewardToken.transferFrom(msg.sender, address(this), _amount);
    }
    
    // Withdraw remaining rewards (emergency)
    function withdrawRewards() external onlyOwner {
        uint256 balance = rewardToken.balanceOf(address(this));
        rewardToken.transfer(owner(), balance);
    }
}
