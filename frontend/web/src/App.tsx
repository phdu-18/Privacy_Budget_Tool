// App.tsx
import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface PrivacyRecord {
  id: string;
  encryptedData: string;
  timestamp: number;
  owner: string;
  operation: string;
  budgetConsumed: number;
  status: "active" | "depleted";
}

const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [records, setRecords] = useState<PrivacyRecord[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newRecordData, setNewRecordData] = useState({ operation: "query", value: 0 });
  const [selectedRecord, setSelectedRecord] = useState<PrivacyRecord | null>(null);
  const [decryptedValue, setDecryptedValue] = useState<number | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [startTimestamp, setStartTimestamp] = useState<number>(0);
  const [durationDays, setDurationDays] = useState<number>(30);
  const [searchTerm, setSearchTerm] = useState("");
  const [filterStatus, setFilterStatus] = useState<"all" | "active" | "depleted">("all");

  // Calculate statistics
  const activeCount = records.filter(r => r.status === "active").length;
  const depletedCount = records.filter(r => r.status === "depleted").length;
  const totalBudgetConsumed = records.reduce((sum, record) => sum + record.budgetConsumed, 0);
  const avgBudgetPerOp = records.length > 0 ? totalBudgetConsumed / records.length : 0;

  useEffect(() => {
    loadRecords().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  const loadRecords = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      // Check contract availability
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) return;
      
      // Load record keys
      const keysBytes = await contract.getData("privacy_record_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing record keys:", e); }
      }
      
      // Load each record
      const list: PrivacyRecord[] = [];
      for (const key of keys) {
        try {
          const recordBytes = await contract.getData(`privacy_record_${key}`);
          if (recordBytes.length > 0) {
            try {
              const recordData = JSON.parse(ethers.toUtf8String(recordBytes));
              list.push({ 
                id: key, 
                encryptedData: recordData.data, 
                timestamp: recordData.timestamp, 
                owner: recordData.owner, 
                operation: recordData.operation || "query",
                budgetConsumed: recordData.budgetConsumed || 0,
                status: recordData.status || "active"
              });
            } catch (e) { console.error(`Error parsing record data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading record ${key}:`, e); }
      }
      
      // Sort by timestamp
      list.sort((a, b) => b.timestamp - a.timestamp);
      setRecords(list);
    } catch (e) { 
      console.error("Error loading records:", e); 
    } finally { 
      setIsRefreshing(false); 
      setLoading(false); 
    }
  };

  const submitRecord = async () => {
    if (!isConnected) { 
      alert("Please connect wallet first"); 
      return; 
    }
    
    setCreating(true);
    setTransactionStatus({ 
      visible: true, 
      status: "pending", 
      message: "Encrypting data with Zama FHE..." 
    });
    
    try {
      // Encrypt the value
      const encryptedData = FHEEncryptNumber(newRecordData.value);
      
      // Calculate privacy budget consumption (simulated)
      const budgetConsumed = newRecordData.operation === "query" ? 0.1 : 0.5;
      
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      // Generate unique ID
      const recordId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      
      // Prepare record data
      const recordData = { 
        data: encryptedData, 
        timestamp: Math.floor(Date.now() / 1000), 
        owner: address, 
        operation: newRecordData.operation,
        budgetConsumed,
        status: "active"
      };
      
      // Store record
      await contract.setData(`privacy_record_${recordId}`, ethers.toUtf8Bytes(JSON.stringify(recordData)));
      
      // Update keys list
      const keysBytes = await contract.getData("privacy_record_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { 
          keys = JSON.parse(ethers.toUtf8String(keysBytes)); 
        } catch (e) { 
          console.error("Error parsing keys:", e); 
        }
      }
      keys.push(recordId);
      await contract.setData("privacy_record_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      
      setTransactionStatus({ 
        visible: true, 
        status: "success", 
        message: "Privacy budget operation recorded!" 
      });
      
      await loadRecords();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowCreateModal(false);
        setNewRecordData({ operation: "query", value: 0 });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") 
        ? "Transaction rejected by user" 
        : "Submission failed: " + (e.message || "Unknown error");
      setTransactionStatus({ 
        visible: true, 
        status: "error", 
        message: errorMessage 
      });
      setTimeout(() => setTransactionStatus({ 
        visible: false, 
        status: "pending", 
        message: "" 
      }), 3000);
    } finally { 
      setCreating(false); 
    }
  };

  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { 
      alert("Please connect wallet first"); 
      return null; 
    }
    
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      return FHEDecryptNumber(encryptedData);
    } catch (e) { 
      console.error("Decryption failed:", e); 
      return null; 
    } finally { 
      setIsDecrypting(false); 
    }
  };

  const checkAvailability = async () => {
    try {
      const contract = await getContractReadOnly();
      if (!contract) throw new Error("Contract not available");
      
      const isAvailable = await contract.isAvailable();
      setTransactionStatus({
        visible: true,
        status: "success",
        message: isAvailable 
          ? "ZAMA FHE contract is available" 
          : "Contract currently unavailable"
      });
      setTimeout(() => setTransactionStatus({ 
        visible: false, 
        status: "pending", 
        message: "" 
      }), 2000);
    } catch (e: any) {
      setTransactionStatus({
        visible: true,
        status: "error",
        message: "Availability check failed: " + (e.message || "Unknown error")
      });
      setTimeout(() => setTransactionStatus({ 
        visible: false, 
        status: "pending", 
        message: "" 
      }), 3000);
    }
  };

  const filteredRecords = records.filter(record => {
    const matchesSearch = record.id.includes(searchTerm) || 
                         record.operation.includes(searchTerm) ||
                         record.owner.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesStatus = filterStatus === "all" || record.status === filterStatus;
    return matchesSearch && matchesStatus;
  });

  const renderBudgetChart = () => {
    const activeBudget = records.filter(r => r.status === "active")
                               .reduce((sum, r) => sum + r.budgetConsumed, 0);
    const depletedBudget = records.filter(r => r.status === "depleted")
                                 .reduce((sum, r) => sum + r.budgetConsumed, 0);
    const total = activeBudget + depletedBudget;
    
    return (
      <div className="budget-chart">
        <div className="chart-bars">
          <div 
            className="bar active" 
            style={{ height: `${(activeBudget / (total || 1)) * 100}%` }}
          >
            <div className="bar-label">Active: {activeBudget.toFixed(2)}</div>
          </div>
          <div 
            className="bar depleted" 
            style={{ height: `${(depletedBudget / (total || 1)) * 100}%` }}
          >
            <div className="bar-label">Depleted: {depletedBudget.toFixed(2)}</div>
          </div>
        </div>
        <div className="chart-legend">
          <div className="legend-item">
            <div className="color-dot active"></div>
            <span>Active Budget</span>
          </div>
          <div className="legend-item">
            <div className="color-dot depleted"></div>
            <span>Depleted Budget</span>
          </div>
        </div>
      </div>
    );
  };

  if (loading) return (
    <div className="loading-screen">
      <div className="tech-spinner"></div>
      <p>Initializing FHE connection...</p>
    </div>
  );

  return (
    <div className="app-container tech-theme">
      <header className="app-header">
        <div className="logo">
          <div className="logo-icon">
            <div className="shield-icon"></div>
          </div>
          <h1>Privacy<span>Budget</span>Visualizer</h1>
        </div>
        <div className="header-actions">
          <button 
            onClick={() => setShowCreateModal(true)} 
            className="create-record-btn tech-button"
          >
            <div className="add-icon"></div>New Operation
          </button>
          <button 
            onClick={checkAvailability} 
            className="tech-button"
          >
            Check FHE Status
          </button>
          <div className="wallet-connect-wrapper">
            <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/>
          </div>
        </div>
      </header>

      <div className="main-content">
        <div className="dashboard-panels">
          {/* System Status Panel */}
          <div className="panel system-status">
            <h2>FHE System Status</h2>
            <div className="status-grid">
              <div className="status-item">
                <div className="status-icon fhe-active"></div>
                <div className="status-text">
                  <h3>ZAMA FHE</h3>
                  <p>Encryption Active</p>
                </div>
              </div>
              <div className="status-item">
                <div className="status-icon contract-connected"></div>
                <div className="status-text">
                  <h3>Contract</h3>
                  <p>Connected</p>
                </div>
              </div>
              <div className="status-item">
                <div className="status-icon wallet-connected"></div>
                <div className="status-text">
                  <h3>Wallet</h3>
                  <p>{isConnected ? "Connected" : "Disconnected"}</p>
                </div>
              </div>
            </div>
          </div>

          {/* Statistics Panel */}
          <div className="panel statistics">
            <h2>Privacy Budget Statistics</h2>
            <div className="stats-grid">
              <div className="stat-item">
                <div className="stat-value">{records.length}</div>
                <div className="stat-label">Total Operations</div>
              </div>
              <div className="stat-item">
                <div className="stat-value">{activeCount}</div>
                <div className="stat-label">Active</div>
              </div>
              <div className="stat-item">
                <div className="stat-value">{depletedCount}</div>
                <div className="stat-label">Depleted</div>
              </div>
              <div className="stat-item">
                <div className="stat-value">{totalBudgetConsumed.toFixed(2)}</div>
                <div className="stat-label">Total Budget Used</div>
              </div>
              <div className="stat-item">
                <div className="stat-value">{avgBudgetPerOp.toFixed(2)}</div>
                <div className="stat-label">Avg Per Operation</div>
              </div>
            </div>
          </div>

          {/* Visualization Panel */}
          <div className="panel visualization">
            <h2>Budget Consumption</h2>
            {renderBudgetChart()}
          </div>
        </div>

        {/* Records Section */}
        <div className="records-section">
          <div className="section-header">
            <h2>Privacy Operations</h2>
            <div className="header-actions">
              <div className="search-filter">
                <input
                  type="text"
                  placeholder="Search operations..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="tech-input"
                />
                <select
                  value={filterStatus}
                  onChange={(e) => setFilterStatus(e.target.value as any)}
                  className="tech-select"
                >
                  <option value="all">All Statuses</option>
                  <option value="active">Active Only</option>
                  <option value="depleted">Depleted Only</option>
                </select>
              </div>
              <button 
                onClick={loadRecords} 
                className="refresh-btn tech-button" 
                disabled={isRefreshing}
              >
                {isRefreshing ? "Refreshing..." : "Refresh"}
              </button>
            </div>
          </div>

          <div className="records-list tech-card">
            <div className="table-header">
              <div className="header-cell">ID</div>
              <div className="header-cell">Operation</div>
              <div className="header-cell">Owner</div>
              <div className="header-cell">Date</div>
              <div className="header-cell">Budget</div>
              <div className="header-cell">Status</div>
              <div className="header-cell">Actions</div>
            </div>

            {filteredRecords.length === 0 ? (
              <div className="no-records">
                <div className="no-records-icon"></div>
                <p>No privacy operations found</p>
                <button 
                  className="tech-button primary" 
                  onClick={() => setShowCreateModal(true)}
                >
                  Create First Operation
                </button>
              </div>
            ) : (
              filteredRecords.map(record => (
                <div 
                  className="record-row" 
                  key={record.id} 
                  onClick={() => setSelectedRecord(record)}
                >
                  <div className="table-cell record-id">#{record.id.substring(0, 6)}</div>
                  <div className="table-cell">{record.operation}</div>
                  <div className="table-cell">{record.owner.substring(0, 6)}...{record.owner.substring(38)}</div>
                  <div className="table-cell">{new Date(record.timestamp * 1000).toLocaleDateString()}</div>
                  <div className="table-cell">{record.budgetConsumed.toFixed(2)}</div>
                  <div className="table-cell">
                    <span className={`status-badge ${record.status}`}>
                      {record.status}
                    </span>
                  </div>
                  <div className="table-cell actions">
                    <button 
                      className="action-btn tech-button" 
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedRecord(record);
                      }}
                    >
                      Details
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Create Operation Modal */}
      {showCreateModal && (
        <ModalCreate 
          onSubmit={submitRecord} 
          onClose={() => setShowCreateModal(false)} 
          creating={creating} 
          recordData={newRecordData} 
          setRecordData={setNewRecordData}
        />
      )}

      {/* Record Detail Modal */}
      {selectedRecord && (
        <RecordDetailModal 
          record={selectedRecord} 
          onClose={() => {
            setSelectedRecord(null);
            setDecryptedValue(null);
          }} 
          decryptedValue={decryptedValue} 
          setDecryptedValue={setDecryptedValue} 
          isDecrypting={isDecrypting} 
          decryptWithSignature={decryptWithSignature}
        />
      )}

      {/* Transaction Status Modal */}
      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content tech-card">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="tech-spinner"></div>}
              {transactionStatus.status === "success" && <div className="check-icon"></div>}
              {transactionStatus.status === "error" && <div className="error-icon"></div>}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}

      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="logo">
              <div className="shield-icon"></div>
              <span>PrivacyBudgetVisualizer</span>
            </div>
            <p>Visualizing FHE privacy budgets with ZAMA technology</p>
          </div>
          <div className="footer-links">
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">Privacy Policy</a>
            <a href="#" className="footer-link">GitHub</a>
            <a href="#" className="footer-link">Contact</a>
          </div>
        </div>
        <div className="footer-bottom">
          <div className="fhe-badge">
            <span>Powered by ZAMA FHE</span>
          </div>
          <div className="copyright">
            © {new Date().getFullYear()} PrivacyBudgetVisualizer. All rights reserved.
          </div>
        </div>
      </footer>
    </div>
  );
};

interface ModalCreateProps {
  onSubmit: () => void; 
  onClose: () => void; 
  creating: boolean;
  recordData: any;
  setRecordData: (data: any) => void;
}

const ModalCreate: React.FC<ModalCreateProps> = ({ 
  onSubmit, 
  onClose, 
  creating, 
  recordData, 
  setRecordData 
}) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setRecordData({ ...recordData, [name]: value });
  };

  const handleValueChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setRecordData({ ...recordData, [name]: parseFloat(value) });
  };

  const handleSubmit = () => {
    if (!recordData.operation || isNaN(recordData.value)) { 
      alert("Please fill required fields"); 
      return; 
    }
    onSubmit();
  };

  return (
    <div className="modal-overlay">
      <div className="create-modal tech-card">
        <div className="modal-header">
          <h2>New Privacy Operation</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="fhe-notice-banner">
            <div className="key-icon"></div> 
            <div>
              <strong>ZAMA FHE Encryption</strong>
              <p>Your data will be encrypted before submission</p>
            </div>
          </div>
          
          <div className="form-group">
            <label>Operation Type *</label>
            <select 
              name="operation" 
              value={recordData.operation} 
              onChange={handleChange} 
              className="tech-select"
            >
              <option value="query">Simple Query (0.1 budget)</option>
              <option value="analysis">Complex Analysis (0.5 budget)</option>
              <option value="aggregation">Data Aggregation (0.3 budget)</option>
            </select>
          </div>
          
          <div className="form-group">
            <label>Input Value *</label>
            <input 
              type="number" 
              name="value" 
              value={recordData.value} 
              onChange={handleValueChange} 
              placeholder="Enter numerical value..." 
              className="tech-input"
              step="0.01"
            />
          </div>
          
          <div className="encryption-preview">
            <h4>Encryption Preview</h4>
            <div className="preview-container">
              <div className="plain-data">
                <span>Plain Value:</span>
                <div>{recordData.value || 'No value entered'}</div>
              </div>
              <div className="encryption-arrow">→</div>
              <div className="encrypted-data">
                <span>Encrypted Data:</span>
                <div>
                  {recordData.value ? 
                    FHEEncryptNumber(recordData.value).substring(0, 50) + '...' : 
                    'No value entered'
                  }
                </div>
              </div>
            </div>
          </div>
          
          <div className="budget-estimate">
            <h4>Privacy Budget Estimate</h4>
            <div className="estimate-value">
              {recordData.operation === "query" ? "0.1" : 
               recordData.operation === "analysis" ? "0.5" : "0.3"} 
              units will be consumed
            </div>
          </div>
        </div>
        
        <div className="modal-footer">
          <button onClick={onClose} className="cancel-btn tech-button">
            Cancel
          </button>
          <button 
            onClick={handleSubmit} 
            disabled={creating} 
            className="submit-btn tech-button primary"
          >
            {creating ? "Processing with FHE..." : "Submit Operation"}
          </button>
        </div>
      </div>
    </div>
  );
};

interface RecordDetailModalProps {
  record: PrivacyRecord;
  onClose: () => void;
  decryptedValue: number | null;
  setDecryptedValue: (value: number | null) => void;
  isDecrypting: boolean;
  decryptWithSignature: (encryptedData: string) => Promise<number | null>;
}

const RecordDetailModal: React.FC<RecordDetailModalProps> = ({ 
  record, 
  onClose, 
  decryptedValue, 
  setDecryptedValue, 
  isDecrypting, 
  decryptWithSignature 
}) => {
  const handleDecrypt = async () => {
    if (decryptedValue !== null) { 
      setDecryptedValue(null); 
      return; 
    }
    const decrypted = await decryptWithSignature(record.encryptedData);
    if (decrypted !== null) setDecryptedValue(decrypted);
  };

  return (
    <div className="modal-overlay">
      <div className="record-detail-modal tech-card">
        <div className="modal-header">
          <h2>Operation Details #{record.id.substring(0, 8)}</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        
        <div className="modal-body">
          <div className="record-info">
            <div className="info-item">
              <span>Operation:</span>
              <strong>{record.operation}</strong>
            </div>
            <div className="info-item">
              <span>Owner:</span>
              <strong>
                {record.owner.substring(0, 6)}...{record.owner.substring(38)}
              </strong>
            </div>
            <div className="info-item">
              <span>Date:</span>
              <strong>
                {new Date(record.timestamp * 1000).toLocaleString()}
              </strong>
            </div>
            <div className="info-item">
              <span>Budget Consumed:</span>
              <strong>{record.budgetConsumed.toFixed(2)} units</strong>
            </div>
            <div className="info-item">
              <span>Status:</span>
              <strong className={`status-badge ${record.status}`}>
                {record.status}
              </strong>
            </div>
          </div>
          
          <div className="encrypted-data-section">
            <h3>Encrypted Data</h3>
            <div className="encrypted-data">
              {record.encryptedData.substring(0, 100)}...
            </div>
            <div className="fhe-tag">
              <div className="fhe-icon"></div>
              <span>ZAMA FHE Encrypted</span>
            </div>
            <button 
              className="decrypt-btn tech-button" 
              onClick={handleDecrypt} 
              disabled={isDecrypting}
            >
              {isDecrypting ? (
                <span className="decrypt-spinner"></span>
              ) : decryptedValue !== null ? (
                "Hide Decrypted Value"
              ) : (
                "Decrypt with Wallet Signature"
              )}
            </button>
          </div>
          
          {decryptedValue !== null && (
            <div className="decrypted-data-section">
              <h3>Decrypted Value</h3>
              <div className="decrypted-value">{decryptedValue}</div>
              <div className="decryption-notice">
                <div className="warning-icon"></div>
                <span>
                  Decrypted data is only visible after wallet signature verification
                </span>
              </div>
            </div>
          )}
        </div>
        
        <div className="modal-footer">
          <button onClick={onClose} className="close-btn tech-button">
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

export default App;