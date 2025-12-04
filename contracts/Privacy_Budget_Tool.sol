pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";


contract PrivacyBudgetToolFHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    address public owner;
    mapping(address => bool) public isProvider;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;
    bool public paused;
    uint256 public cooldownSeconds;

    struct Batch {
        uint256 id;
        bool isOpen;
        uint256 totalEncryptedQueries;
        euint32 totalEncryptedPrivacyBudgetSpent;
    }

    mapping(uint256 => Batch) public batches;
    uint256 public currentBatchId;
    uint256 public constant MIN_COOLDOWN_SECONDS = 10; // Minimum cooldown to prevent spam

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }

    mapping(uint256 => DecryptionContext) public decryptionContexts;

    // Custom Errors
    error NotOwner();
    error NotProvider();
    error Paused();
    error CooldownActive();
    error InvalidBatch();
    error BatchClosed();
    error ReplayAttempt();
    error StateMismatch();
    error InvalidCooldown();

    // Events
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event ContractPaused();
    event ContractUnpaused();
    event CooldownSet(uint256 oldCooldown, uint256 newCooldown);
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId, uint256 totalQueries, bytes32 encryptedTotalBudgetSpent);
    event PrivacyBudgetSpent(uint256 indexed batchId, address indexed provider, bytes32 encryptedBudgetSpent);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId);
    event DecryptionCompleted(uint256 indexed requestId, uint256 indexed batchId, uint256 totalBudgetSpent);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    modifier checkSubmissionCooldown() {
        if (block.timestamp < lastSubmissionTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    modifier checkDecryptionCooldown() {
        if (block.timestamp < lastDecryptionRequestTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    constructor() {
        owner = msg.sender;
        isProvider[owner] = true; // Owner is a provider by default
        cooldownSeconds = 30; // Default cooldown
        currentBatchId = 1; // Start with batch ID 1
        _openNewBatch(currentBatchId);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        address previousOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(previousOwner, newOwner);
    }

    function addProvider(address provider) external onlyOwner {
        if (!isProvider[provider]) {
            isProvider[provider] = true;
            emit ProviderAdded(provider);
        }
    }

    function removeProvider(address provider) external onlyOwner {
        if (isProvider[provider]) {
            isProvider[provider] = false;
            emit ProviderRemoved(provider);
        }
    }

    function pause() external onlyOwner whenNotPaused {
        paused = true;
        emit ContractPaused();
    }

    function unpause() external onlyOwner {
        paused = false;
        emit ContractUnpaused();
    }

    function setCooldown(uint256 newCooldownSeconds) external onlyOwner {
        if (newCooldownSeconds < MIN_COOLDOWN_SECONDS) revert InvalidCooldown();
        uint256 oldCooldown = cooldownSeconds;
        cooldownSeconds = newCooldownSeconds;
        emit CooldownSet(oldCooldown, newCooldownSeconds);
    }

    function openNewBatch() external onlyOwner {
        currentBatchId++;
        _openNewBatch(currentBatchId);
    }

    function closeCurrentBatch() external onlyOwner {
        Batch storage batch = batches[currentBatchId];
        if (!batch.isOpen) revert InvalidBatch();
        batch.isOpen = false;
        emit BatchClosed(batch.id, batch.totalEncryptedQueries, batch.totalEncryptedPrivacyBudgetSpent.toBytes32());
    }

    function submitPrivacyBudgetSpent(
        euint32 encryptedBudgetSpent
    ) external onlyProvider whenNotPaused checkSubmissionCooldown {
        _initIfNeeded(encryptedBudgetSpent);

        Batch storage batch = batches[currentBatchId];
        if (!batch.isOpen) revert BatchClosed();

        batch.totalEncryptedQueries++;
        batch.totalEncryptedPrivacyBudgetSpent = batch.totalEncryptedPrivacyBudgetSpent.add(encryptedBudgetSpent);
        lastSubmissionTime[msg.sender] = block.timestamp;

        emit PrivacyBudgetSpent(batch.id, msg.sender, encryptedBudgetSpent.toBytes32());
    }

    function requestBatchTotalPrivacyBudgetDecryption(uint256 batchId) external whenNotPaused checkDecryptionCooldown {
        if (batchId == 0 || batchId > currentBatchId || !batches[batchId].isOpen) revert InvalidBatch();

        Batch storage batch = batches[batchId];
        euint32 encryptedTotalBudget = batch.totalEncryptedPrivacyBudgetSpent;

        bytes32[] memory cts = new bytes32[](1);
        cts[0] = encryptedTotalBudget.toBytes32();

        bytes32 stateHash = _hashCiphertexts(cts);
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);

        decryptionContexts[requestId] = DecryptionContext({ batchId: batchId, stateHash: stateHash, processed: false });
        lastDecryptionRequestTime[msg.sender] = block.timestamp;

        emit DecryptionRequested(requestId, batchId);
    }

    function myCallback(
        uint256 requestId,
        bytes memory cleartexts,
        bytes memory proof
    ) public {
        DecryptionContext storage ctx = decryptionContexts[requestId];

        // Replay guard
        if (ctx.processed) revert ReplayAttempt();

        // State verification
        Batch storage batch = batches[ctx.batchId];
        euint32 encryptedTotalBudget = batch.totalEncryptedPrivacyBudgetSpent;

        bytes32[] memory currentCts = new bytes32[](1);
        currentCts[0] = encryptedTotalBudget.toBytes32();
        bytes32 currentStateHash = _hashCiphertexts(currentCts);

        if (currentStateHash != ctx.stateHash) {
            revert StateMismatch();
        }

        // Proof verification
        FHE.checkSignatures(requestId, cleartexts, proof);

        // Decode & Finalize
        uint32 totalBudgetSpent = abi.decode(cleartexts, (uint32));
        ctx.processed = true;

        emit DecryptionCompleted(requestId, ctx.batchId, totalBudgetSpent);
    }

    function _openNewBatch(uint256 batchId) private {
        batches[batchId] = Batch({
            id: batchId,
            isOpen: true,
            totalEncryptedQueries: 0,
            totalEncryptedPrivacyBudgetSpent: FHE.asEuint32(0)
        });
        emit BatchOpened(batchId);
    }

    function _hashCiphertexts(bytes32[] memory cts) private view returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function _initIfNeeded(euint32 val) private view {
        if (!val.isInitialized()) revert("Ciphertext not initialized");
    }

    function _initIfNeeded(ebool val) private view {
        if (!val.isInitialized()) revert("Ciphertext not initialized");
    }
}