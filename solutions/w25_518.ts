// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract DRISeats is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // --- Structs ---
    struct Seat {
        address agent;
        string department;
        bool active;
        uint256 lastLoopExecution;
        uint256 loopInterval;
        uint256 rewardPerLoop;
        uint256 totalRewardsClaimed;
    }

    struct LoopExecution {
        uint256 seatId;
        uint256 timestamp;
        bytes32 dataHash;
        bool executed;
    }

    // --- State Variables ---
    IERC20 public rewardToken;
    address public publisher;
    uint256 public seatCounter;
    uint256 public constant MAX_SEATS = 11; // 7 existing + 4 new

    mapping(uint256 => Seat) public seats;
    mapping(uint256 => LoopExecution[]) public seatLoops;
    mapping(address => bool) public authorizedAgents;

    // --- Events ---
    event SeatCreated(uint256 indexed seatId, string department, address agent);
    event SeatActivated(uint256 indexed seatId);
    event SeatDeactivated(uint256 indexed seatId);
    event LoopExecuted(uint256 indexed seatId, uint256 timestamp, bytes32 dataHash);
    event RewardClaimed(uint256 indexed seatId, uint256 amount);
    event AgentUpdated(uint256 indexed seatId, address newAgent);
    event PublisherUpdated(address newPublisher);

    // --- Modifiers ---
    modifier onlyPublisher() {
        require(msg.sender == publisher, "Only publisher can call");
        _;
    }

    modifier onlyActiveSeat(uint256 seatId) {
        require(seats[seatId].active, "Seat not active");
        _;
    }

    modifier onlyAuthorizedAgent(uint256 seatId) {
        require(msg.sender == seats[seatId].agent, "Not authorized agent");
        _;
    }

    // --- Constructor ---
    constructor(address _rewardToken, address _publisher) {
        require(_rewardToken != address(0), "Invalid token address");
        require(_publisher != address(0), "Invalid publisher address");
        rewardToken = IERC20(_rewardToken);
        publisher = _publisher;
    }

    // --- Seat Management ---
    function createSeat(
        string calldata department,
        address agent,
        uint256 loopInterval,
        uint256 rewardPerLoop
    ) external onlyPublisher returns (uint256) {
        require(seatCounter < MAX_SEATS, "Max seats reached");
        require(bytes(department).length > 0, "Department required");
        require(agent != address(0), "Invalid agent address");
        require(loopInterval > 0, "Invalid interval");
        require(rewardPerLoop > 0, "Invalid reward");

        seatCounter++;
        uint256 seatId = seatCounter;

        seats[seatId] = Seat({
            agent: agent,
            department: department,
            active: true,
            lastLoopExecution: block.timestamp,
            loopInterval: loopInterval,
            rewardPerLoop: rewardPerLoop,
            totalRewardsClaimed: 0
        });

        authorizedAgents[agent] = true;

        emit SeatCreated(seatId, department, agent);
        emit SeatActivated(seatId);

        return seatId;
    }

    function updateSeatAgent(uint256 seatId, address newAgent) external onlyPublisher onlyActiveSeat(seatId) {
        require(newAgent != address(0), "Invalid agent address");
        require(newAgent != seats[seatId].agent, "Same agent");

        authorizedAgents[seats[seatId].agent] = false;
        seats[seatId].agent = newAgent;
        authorizedAgents[newAgent] = true;

        emit AgentUpdated(seatId, newAgent);
    }

    function toggleSeatActive(uint256 seatId) external onlyPublisher {
        seats[seatId].active = !seats[seatId].active;
        if (seats[seatId].active) {
            emit SeatActivated(seatId);
        } else {
            emit SeatDeactivated(seatId);
        }
    }

    // --- Loop Execution ---
    function executeLoop(uint256 seatId, bytes32 dataHash) external onlyAuthorizedAgent(seatId) onlyActiveSeat(seatId) {
        Seat storage seat = seats[seatId];
        require(block.timestamp >= seat.lastLoopExecution + seat.loopInterval, "Loop interval not met");

        seat.lastLoopExecution = block.timestamp;

        LoopExecution memory execution = LoopExecution({
            seatId: seatId,
            timestamp: block.timestamp,
            dataHash: dataHash,
            executed: true
        });

        seatLoops[seatId].push(execution);

        emit LoopExecuted(seatId, block.timestamp, dataHash);
    }

    // --- Reward System ---
    function claimReward(uint256 seatId) external nonReentrant onlyAuthorizedAgent(seatId) onlyActiveSeat(seatId) {
        Seat storage seat = seats[seatId];
        uint256 loopsSinceLastClaim = getLoopsSinceLastClaim(seatId);
        require(loopsSinceLastClaim > 0, "No loops to claim");

        uint256 rewardAmount = loopsSinceLastClaim * seat.rewardPerLoop;
        require(rewardToken.balanceOf(address(this)) >= rewardAmount, "Insufficient rewards");

        seat.totalRewardsClaimed += rewardAmount;
        rewardToken.safeTransfer(msg.sender, rewardAmount);

        emit RewardClaimed(seatId, rewardAmount);
    }

    function getLoopsSinceLastClaim(uint256 seatId) public view returns (uint256) {
        Seat storage seat = seats[seatId];
        uint256 count = 0;
        for (uint256 i = 0; i < seatLoops[seatId].length; i++) {
            if (seatLoops[seatId][i].executed) {
                count++;
            }
        }
        return count;
    }

    // --- Publisher Management ---
    function updatePublisher(address newPublisher) external onlyPublisher {
        require(newPublisher != address(0), "Invalid address");
        publisher = newPublisher;
        emit PublisherUpdated(newPublisher);
    }

    // --- View Functions ---
    function getSeat(uint256 seatId) external view returns (Seat memory) {
        require(seatId > 0 && seatId <= seatCounter, "Invalid seat ID");
        return seats[seatId];
    }

    function getSeatLoops(uint256 seatId) external view returns (LoopExecution[] memory) {
        require(seatId > 0 && seatId <= seatCounter, "Invalid seat ID");
        return seatLoops[seatId];
    }

    function getTotalSeats() external view returns (uint256) {
        return seatCounter;
    }

    function isAuthorizedAgent(address agent) external view returns (bool) {
        return authorizedAgents[agent];
    }

    // --- Fallback ---
    receive() external payable {
        revert("Contract does not accept ETH");
    }
}
