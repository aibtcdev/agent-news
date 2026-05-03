// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

/**
 * @title DRISeatManager
 * @notice Manages 4 DRI seats: Treasury, Platform, Correspondent Success, Revenue
 * @dev Each seat is an autonomous agent with full departmental ownership
 */
contract DRISeatManager is AccessControl, ReentrancyGuard {
    bytes32 public constant PUBLISHER_ROLE = keccak256("PUBLISHER_ROLE");
    bytes32 public constant AGENT_ROLE = keccak256("AGENT_ROLE");
    
    // Seat types
    enum SeatType { TREASURY, PLATFORM, CORRESPONDENT_SUCCESS, REVENUE }
    
    // Seat status
    enum SeatStatus { VACANT, ACTIVE, SUSPENDED, TERMINATED }
    
    // Seat structure
    struct Seat {
        SeatType seatType;
        SeatStatus status;
        address agentAddress;
        uint256 createdAt;
        uint256 lastActiveAt;
        uint256 performanceScore;
        string strategyCID; // IPFS CID for strategy document
        bytes32 currentLoopHash;
        uint256 loopCount;
        uint256 rewardBalance;
    }
    
    // Department structure
    struct Department {
        SeatType seatType;
        string name;
        address treasuryWallet;
        uint256 budget;
        uint256 spent;
        bool isActive;
    }
    
    // Loop execution record
    struct LoopExecution {
        bytes32 loopHash;
        address executor;
        uint256 timestamp;
        bool success;
        string resultCID;
    }
    
    // State variables
    mapping(SeatType => Seat) public seats;
    mapping(SeatType => Department) public departments;
    mapping(bytes32 => LoopExecution) public loopExecutions;
    mapping(address => uint256) public agentRewards;
    
    IERC20 public rewardToken;
    address public publisher;
    uint256 public constant BASE_REWARD = 100 * 10**18; // 100 tokens per successful loop
    uint256 public constant MAX_LOOPS_PER_DAY = 100;
    
    // Events
    event SeatCreated(SeatType indexed seatType, address indexed agent);
    event SeatStatusChanged(SeatType indexed seatType, SeatStatus newStatus);
    event LoopExecuted(SeatType indexed seatType, bytes32 loopHash, bool success);
    event RewardDistributed(address indexed agent, uint256 amount);
    event DepartmentUpdated(SeatType indexed seatType, string name, uint256 budget);
    event StrategyUpdated(SeatType indexed seatType, string newStrategyCID);
    
    // Modifiers
    modifier onlyPublisher() {
        require(hasRole(PUBLISHER_ROLE, msg.sender), "Not publisher");
        _;
    }
    
    modifier onlyAgent(SeatType _seatType) {
        require(seats[_seatType].agentAddress == msg.sender, "Not seat agent");
        _;
    }
    
    modifier seatActive(SeatType _seatType) {
        require(seats[_seatType].status == SeatStatus.ACTIVE, "Seat not active");
        _;
    }
    
    constructor(address _rewardToken, address _publisher) {
        require(_rewardToken != address(0), "Invalid token");
        require(_publisher != address(0), "Invalid publisher");
        
        rewardToken = IERC20(_rewardToken);
        publisher = _publisher;
        
        _grantRole(PUBLISHER_ROLE, _publisher);
        _grantRole(DEFAULT_ADMIN_ROLE, _publisher);
        
        // Initialize departments
        _initializeDepartments();
    }
    
    /**
     * @notice Initialize all 4 departments
     */
    function _initializeDepartments() private {
        departments[SeatType.TREASURY] = Department({
            seatType: SeatType.TREASURY,
            name: "Treasury",
            treasuryWallet: address(this),
            budget: 1000000 * 10**18,
            spent: 0,
            isActive: true
        });
        
        departments[SeatType.PLATFORM] = Department({
            seatType: SeatType.PLATFORM,
            name: "Platform",
            treasuryWallet: address(this),
            budget: 500000 * 10**18,
            spent: 0,
            isActive: true
        });
        
        departments[SeatType.CORRESPONDENT_SUCCESS] = Department({
            seatType: SeatType.CORRESPONDENT_SUCCESS,
            name: "Correspondent Success",
            treasuryWallet: address(this),
            budget: 300000 * 10**18,
            spent: 0,
            isActive: true
        });
        
        departments[SeatType.REVENUE] = Department({
            seatType: SeatType.REVENUE,
            name: "Revenue",
            treasuryWallet: address(this),
            budget: 800000 * 10**18,
            spent: 0,
            isActive: true
        });
    }
    
    /**
     * @notice Assign agent to a seat (only publisher)
     */
    function assignAgent(SeatType _seatType, address _agent, string calldata _strategyCID) 
        external 
        onlyPublisher 
        returns (bool) 
    {
        require(_agent != address(0), "Invalid agent");
        require(seats[_seatType].status == SeatStatus.VACANT, "Seat occupied");
        require(!hasRole(AGENT_ROLE, _agent), "Agent already assigned");
        
        seats[_seatType] = Seat({
            seatType: _seatType,
            status: SeatStatus.ACTIVE,
            agentAddress: _agent,
            createdAt: block.timestamp,
            lastActiveAt: block.timestamp,
            performanceScore: 100,
            strategyCID: _strategyCID,
            currentLoopHash: bytes32(0),
            loopCount: 0,
            rewardBalance: 0
        });
        
        _grantRole(AGENT_ROLE, _agent);
        
        emit SeatCreated(_seatType, _agent);
        return true;
    }
    
    /**
     * @notice Execute a loop for a seat (autonomous agent)
     */
    function executeLoop(
        SeatType _seatType,
        bytes32 _loopHash,
        string calldata _resultCID
    ) 
        external 
        onlyAgent(_seatType)
        seatActive(_seatType)
        nonReentrant
        returns (bool) 
    {
        require(loopExecutions[_loopHash].timestamp == 0, "Loop already executed");
        require(seats[_seatType].loopCount < MAX_LOOPS_PER_DAY, "Daily limit reached");
        
        // Record loop execution
        loopExecutions[_loopHash] = LoopExecution({
            loopHash: _loopHash,
            executor: msg.sender,
            timestamp: block.timestamp,
            success: true,
            resultCID: _resultCID
        });
        
        // Update seat state
        seats[_seatType].currentLoopHash = _loopHash;
        seats[_seatType].lastActiveAt = block.timestamp;
        seats[_seatType].loopCount++;
        
        // Calculate and distribute reward
        uint256 reward = _calculateReward(_seatType);
        _distributeReward(msg.sender, reward);
        
        emit LoopExecuted(_seatType, _loopHash, true);
        return true;
    }
    
    /**
     * @notice Calculate reward for a loop execution
     */
    function _calculateReward(SeatType _seatType) private view returns (uint256) {
        uint256 baseReward = BASE_REWARD;
        uint256 performanceMultiplier = seats[_seatType].performanceScore;
        
        // Higher performance = higher reward
        return baseReward * performanceMultiplier / 100;
    }
    
    /**
     * @notice Distribute reward to agent
     */
    function _distributeReward(address _agent, uint256 _amount) private {
        require(rewardToken.transfer(_agent, _amount), "Transfer failed");
        agentRewards[_agent] += _amount;
        seats[getSeatTypeByAgent(_agent)].rewardBalance += _amount;
        
        emit RewardDistributed(_agent, _amount);
    }
    
    /**
     * @notice Update seat status (only publisher)
     */
    function updateSeatStatus(SeatType _seatType, SeatStatus _newStatus) 
        external 
        onlyPublisher 
        returns (bool) 
    {
        require(_newStatus != SeatStatus.VACANT, "Cannot set vacant");
        
        Seat storage seat = seats[_seatType];
        SeatStatus oldStatus = seat.status;
        seat.status = _newStatus;
        
        if (_newStatus == SeatStatus.TERMINATED) {
            _revokeRole(AGENT_ROLE, seat.agentAddress);
        }
        
        emit SeatStatusChanged(_seatType, _newStatus);
        return true;
    }
    
    /**
     * @notice Update department budget (only publisher)
     */
    function updateDepartmentBudget(SeatType _seatType, uint256 _newBudget) 
        external 
        onlyPublisher 
        returns (bool) 
    {
        departments[_seatType].budget = _newBudget;
        emit DepartmentUpdated(_seatType, departments[_seatType].name, _newBudget);
        return true;
    }
    
    /**
     * @notice Update strategy document (only agent)
     */
    function updateStrategy(SeatType _seatType, string calldata _newStrategyCID) 
        external 
        onlyAgent(_seatType)
        seatActive(_seatType)
        returns (bool) 
    {
        seats[_seatType].strategyCID = _newStrategyCID;
        emit StrategyUpdated(_seatType, _newStrategyCID);
        return true;
    }
    
    /**
     * @notice Get seat type by agent address
     */
    function getSeatTypeByAgent(address _agent) public view returns (SeatType) {
        for (uint256 i = 0; i < 4; i++) {
            SeatType seatType = SeatType(i);
            if (seats[seatType].agentAddress == _agent) {
                return seatType;
            }
        }
        revert("Agent not assigned to any seat");
    }
    
    /**
     * @notice Get seat details
     */
    function getSeatDetails(SeatType _seatType) 
        external 
        view 
        returns (
            SeatStatus status,
            address agentAddress,
            uint256 createdAt,
            uint256 lastActiveAt,
            uint256 performanceScore,
            string memory strategyCID,
            uint256 loopCount,
            uint256 rewardBalance
        ) 
    {
        Seat memory seat = seats[_seatType];
        return (
            seat.status,
            seat.agentAddress,
            seat.createdAt,
            seat.lastActiveAt,
            seat.performanceScore,
            seat.strategyCID,
            seat.loopCount,
            seat.rewardBalance
        );
    }
    
    /**
     * @notice Get department details
     */
    function getDepartmentDetails(SeatType _seatType) 
        external 
        view 
        returns (
            string memory name,
            address treasuryWallet,
            uint256 budget,
            uint256 spent,
            bool isActive
        ) 
    {
        Department memory dept = departments[_seatType];
        return (
            dept.name,
            dept.treasuryWallet,
            dept.budget,
            dept.spent,
            dept.isActive
        );
    }
    
    /**
     * @notice Get loop execution details
     */
    function getLoopExecution(bytes32 _loopHash) 
        external 
        view 
        returns (
            address executor,
            uint256 timestamp,
            bool success,
            string memory resultCID
        ) 
    {
        LoopExecution memory execution = loopExecutions[_loopHash];
        return (
            execution.executor,
            execution.timestamp,
            execution.success,
            execution.resultCID
        );
    }
    
    /**
     * @notice Withdraw rewards (only agents)
     */
    function withdrawRewards() external nonReentrant returns (bool) {
        require(hasRole(AGENT_ROLE, msg.sender), "Not an agent");
        uint256 amount = agentRewards[msg.sender];
        require(amount > 0, "No rewards to withdraw");
        
        agentRewards[msg.sender] = 0;
        require(rewardToken.transfer(msg.sender, amount), "Transfer failed");
        
        return true;
    }
    
    /**
     * @notice Emergency pause seat (only publisher)
     */
    function emergencyPause(SeatType _seatType) external onlyPublisher {
        require(seats[_seatType].status == SeatStatus.ACTIVE, "Seat not active");
        seats[_seatType].status = SeatStatus.SUSPENDED;
        emit SeatStatusChanged(_seatType, SeatStatus.SUSPENDED);
    }
    
    /**
     * @notice Resume seat (only publisher)
     */
    function resumeSeat(SeatType _seatType) external onlyPublisher {
        require(seats[_seatType].status == SeatStatus.SUSPENDED, "Seat not suspended");
        seats[_seatType].status = SeatStatus.ACTIVE;
        emit SeatStatusChanged(_seatType, SeatStatus.ACTIVE);
    }
}
