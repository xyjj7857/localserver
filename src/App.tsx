import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { Layout } from './components/Layout';
import { Dashboard } from './components/Dashboard';
import { ScannerView } from './components/ScannerView';
import { LogView } from './components/LogView';
import { SettingsView } from './components/SettingsView';
import { StrategyClient } from './services/strategyClient';
import { AppSettings, LogEntry } from './shared/types';

export default function App() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [activeTab, setActiveTab] = useState('dashboard');
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [ip, setIp] = useState('加载中...');
  const [localIp, setLocalIp] = useState('加载中...');
  const [engineState, setEngineState] = useState<any>({
    stage0Results: [],
    stage0PResults: [],
    stage0PReasons: {},
    stage1Results: [],
    stage2Results: [],
    activePosition: null,
    activeOrders: [],
    accountInfo: null,
    btcData: null,
    wsStatus: 'CLOSED',
    masterSwitch: false,
    scanTimes: {
      stage0Duration: 0,
      stage0PDuration: 0,
      stage1Duration: 0,
      stage2Duration: 0,
      stage0LastStart: 0,
      stage0PLastStart: 0,
      stage1LastStart: 0,
      stage2LastStart: 0,
      stage0NextStart: 0,
      stage0PNextStart: 0,
      stage1NextStart: 0,
      stage2NextStart: 0,
      stage0Countdown: 0,
      stage0PCountdown: 0,
      stage1Countdown: 0,
      stage2Countdown: 0,
      orderNext: 0,
      bestSelectionTime: 0
    }
  });

  const clientRef = useRef<StrategyClient | null>(null);

  // Initialize Strategy Client
  useEffect(() => {
    const client = new StrategyClient((state) => {
      setEngineState((prev: any) => ({ ...prev, ...state }));
      if (state.ip) setIp(state.ip);
    });
    
    clientRef.current = client;
    client.connect();

    // Initial data fetch
    const initData = async () => {
      const s = await client.getSettings();
      if (s) setSettings(s);
      
      const l = await client.getLogs();
      setLogs(l);

      // Fetch Server IP
      try {
        const res = await axios.get('/api/ip');
        setIp(res.data.ip);
      } catch (e) {}

      // Fetch Local IP
      try {
        const res = await axios.get('https://api.ipify.org?format=json');
        setLocalIp(res.data.ip);
      } catch (e) {}
    };

    initData();

    // Periodic log refresh
    const logInterval = setInterval(async () => {
      if (clientRef.current) {
        const l = await clientRef.current.getLogs();
        setLogs(l);
      }
    }, 5000);

    return () => {
      client.close();
      clearInterval(logInterval);
    };
  }, []);

  const handleSaveSettings = async (newSettings: AppSettings) => {
    if (clientRef.current) {
      await clientRef.current.updateSettings(newSettings);
      setSettings(newSettings);
      const l = await clientRef.current.getLogs();
      setLogs(l);
    }
  };

  const handleToggleMaster = async (val: boolean) => {
    if (clientRef.current) {
      await clientRef.current.setMasterSwitch(val);
      setEngineState((prev: any) => ({ ...prev, masterSwitch: val }));
      const l = await clientRef.current.getLogs();
      setLogs(l);
    }
  };

  const handleClearLogs = () => {
    // Server-side clear logs not implemented yet, but we can filter locally or add endpoint
    setLogs([]);
  };

  const refreshIp = async () => {
    setIp('正在刷新...');
    try {
      const res = await axios.get('/api/ip');
      setIp(res.data.ip);
    } catch (err) {
      setIp('获取失败');
    }
  };

  if (!settings) {
    return <div className="flex items-center justify-center h-screen">正在加载配置...</div>;
  }

  return (
    <Layout 
      activeTab={activeTab} 
      setActiveTab={setActiveTab}
      masterSwitch={engineState.masterSwitch}
      onToggleMaster={handleToggleMaster}
      serverIp={ip}
    >
      {activeTab === 'dashboard' && <Dashboard state={engineState} ip={ip} localIp={localIp} />}
      {activeTab === 'scanner' && (
        <ScannerView 
          state={engineState} 
          onForceStage0={() => clientRef.current?.forceScan(0)}
          onForceStage0P={() => clientRef.current?.forceScan('0P')}
          onForceStage1={() => clientRef.current?.forceScan(1)}
          onForceStage2={() => clientRef.current?.forceScan(2)}
        />
      )}
      {activeTab === 'logs' && <LogView logs={logs} onClear={handleClearLogs} />}
      {activeTab === 'settings' && <SettingsView settings={settings} onSave={handleSaveSettings} ip={ip} onRefreshIp={refreshIp} />}
    </Layout>
  );
}
