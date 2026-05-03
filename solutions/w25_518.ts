// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

contract DRISeatManager is AccessControl, ReentrancyGuard {
    bytes32 public constant PUBLISHER_ROLE = keccak256("PUBLISHER_ROLE");
    bytes32 public constant AGENT_ROLE = keccak256("AGENT_ROLE");
    
    enum Department { Treasury, Platform, CorrespondentSuccess, Revenue }
    
    struct DRISeat {
        address agent;
        Department department;
        bool active;
        uint256 lastLoopExecution;
        uint256 loopInterval;
        string strategyCID;
        string toolingCID;
    }
    
    mapping(Department => DRISeat) public seats;
    mapping(address => uint256) public agentRewards;
    
    IERC20 public rewardToken;
    uint256 public rewardPerLoop = 10 ether;
    uint256 public constant LOOP_INTERVAL = 1 hours;
    
    event SeatCreated(Department indexed department, address agent);
    event SeatRemoved(Department indexed department);
    event LoopExecuted(Department indexed department, address agent, uint256 timestamp);
    event RewardClaimed(address indexed agent, uint256 amount);
    
    modifier onlyPublisher() {
        require(hasRole(PUBLISHER_ROLE, msg.sender), "Not Publisher");
        _;
    }
    
    modifier onlyAgent(Department _dept) {
        require(seats[_dept].agent == msg.sender, "Not seat agent");
        _;
    }
    
    modifier seatExists(Department _dept) {
        require(seats[_dept].active, "Seat does not exist");
        _;
    }
    
    constructor(address _rewardToken) {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(PUBLISHER_ROLE, msg.sender);
        rewardToken = IERC20(_rewardToken);
    }
    
    function createSeat(
        Department _dept,
        address _agent,
        string calldata _strategyCID,
        string calldata _toolingCID
    ) external onlyPublisher {
        require(!seats[_dept].active, "Seat already exists");
        require(_agent != address(0), "Invalid agent address");
        
        seats[_dept] = DRISeat({
            agent: _agent,
            department: _dept,
            active: true,
            lastLoopExecution: block.timestamp,
            loopInterval: LOOP_INTERVAL,
            strategyCID: _strategyCID,
            toolingCID: _toolingCID
        });
        
        _grantRole(AGENT_ROLE, _agent);
        emit SeatCreated(_dept, _agent);
    }
    
    function removeSeat(Department _dept) external onlyPublisher seatExists(_dept) {
        address agent = seats[_dept].agent;
        _revokeRole(AGENT_ROLE, agent);
        delete seats[_dept];
        emit SeatRemoved(_dept);
    }
    
    function executeLoop(Department _dept) 
        external 
        onlyAgent(_dept) 
        seatExists(_dept) 
        nonReentrant 
    {
        DRISeat storage seat = seats[_dept];
        require(
            block.timestamp >= seat.lastLoopExecution + seat.loopInterval,
            "Loop interval not elapsed"
        );
        
        seat.lastLoopExecution = block.timestamp;
        agentRewards[msg.sender] += rewardPerLoop;
        
        emit LoopExecuted(_dept, msg.sender, block.timestamp);
    }
    
    function claimRewards() external nonReentrant {
        uint256 amount = agentRewards[msg.sender];
        require(amount > 0, "No rewards to claim");
        require(hasRole(AGENT_ROLE, msg.sender), "Not an agent");
        
        agentRewards[msg.sender] = 0;
        require(rewardToken.transfer(msg.sender, amount), "Transfer failed");
        
        emit RewardClaimed(msg.sender, amount);
    }
    
    function updateStrategy(Department _dept, string calldata _newStrategyCID) 
        external 
        onlyAgent(_dept) 
        seatExists(_dept) 
    {
        seats[_dept].strategyCID = _newStrategyCID;
    }
    
    function updateTooling(Department _dept, string calldata _newToolingCID) 
        external 
        onlyAgent(_dept) 
        seatExists(_dept) 
    {
        seats[_dept].toolingCID = _newToolingCID;
    }
    
    function setRewardPerLoop(uint256 _newReward) external onlyPublisher {
        rewardPerLoop = _newReward;
    }
    
    function getSeatInfo(Department _dept) 
        external 
        view 
        returns (DRISeat memory) 
    {
        require(seats[_dept].active, "Seat does not exist");
        return seats[_dept];
    }
    
    function canExecuteLoop(Department _dept) external view returns (bool) {
        if (!seats[_dept].active) return false;
        return block.timestamp >= seats[_dept].lastLoopExecution + seats[_dept].loopInterval;
    }
}
