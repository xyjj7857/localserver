import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { Layout } from './components/Layout';
import { Dashboard } from './components/Dashboard';
import { ScannerView } from './components/ScannerView';
import { LogView } from './components/LogView';
import { SettingsView } from './components/SettingsView';
import { StorageService } from './services/storage';
import { StrategyEngine } from './services/strategy';
import { BinanceService } from './services/binance';
import { SupabaseService } from './services/supabase';
import { AppSettings, LogEntry } from './types';

export default function App() {
  const [settings, setSettings] = useState<AppSettings>(() => {
    const s = StorageService.getSettings();
    s.masterSwitch = true; // 默认开启策略
    return s;
  });
  const [activeTab, setActiveTab] = useState('dashboard');
  const [logs, setLogs] = useState<LogEntry[]>(StorageService.getLogs());
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
    masterSwitch: settings.masterSwitch,
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

  const engineRef = useRef<StrategyEngine | null>(null);

  // Auto-pull from Supabase on mount
  useEffect(() => {
    const pullRemoteSettings = async () => {
      try {
        const remoteSettings = await SupabaseService.pullSettings(settings);
        if (remoteSettings) {
          // 1. 同步配置
          remoteSettings.masterSwitch = true; // 强制开启
          setSettings(remoteSettings);
          StorageService.saveSettings(remoteSettings);
          if (engineRef.current) {
            engineRef.current.updateSettings(remoteSettings);
          }
          
          // 2. 记录日志
          StorageService.addLog({ 
            module: 'System', 
            type: 'system', 
            message: '已从 Supabase 同步配置并自动开启策略' 
          });
          setLogs(StorageService.getLogs());

          // 3. 确保开启状态
          handleToggleMaster(true);
        } else {
          // 如果拉取失败，仍然开启本地开关
          handleToggleMaster(true);
        }
      } catch (e) {
        console.error('Failed to auto-pull settings from Supabase:', e);
        handleToggleMaster(true);
      }
    };
    pullRemoteSettings();
  }, []);

  // Initialize Strategy Engine
  useEffect(() => {
    const engine = new StrategyEngine(settings, (state) => {
      setEngineState((prev: any) => ({ ...prev, ...state }));
      if (state.ip) setIp(state.ip);
      // Sync logs when they change (StorageService adds them, but we need to update UI)
      setLogs(StorageService.getLogs());
    });
    
    engineRef.current = engine;
    engine.start();

    // Fetch IPs
    const binance = new BinanceService(settings.binance.apiKey, settings.binance.secretKey, settings.binance.baseUrl);
    
    // Test backend connectivity
    axios.get('/api/test')
      .then(res => console.log('Backend test response:', res.data))
      .catch(err => console.error('Backend test failed:', err));

    const fetchIp = async (retryCount = 0) => {
      try {
        const ip = await binance.getIp();
        console.log(`Fetched server IP (attempt ${retryCount + 1}):`, ip);
        if (ip !== 'Unknown') {
          setIp(ip);
        } else if (retryCount < 3) {
          console.warn('Server IP is Unknown, retrying in 2s...');
          setTimeout(() => fetchIp(retryCount + 1), 2000);
        }
      } catch (err) {
        console.error('Error in fetchIp:', err);
      }
    };
    
    fetchIp();
    
    axios.get('https://api.ipify.org?format=json')
      .then(res => {
        console.log('Local IP fetched:', res.data.ip);
        setLocalIp(res.data.ip);
      })
      .catch((err) => {
        console.error('Local IP fetch failed:', err);
        setLocalIp('获取失败');
      });

    return () => {
      if (engineRef.current) {
        engineRef.current.stop();
      }
    };
  }, []);

  const handleSaveSettings = (newSettings: AppSettings) => {
    setSettings(newSettings);
    StorageService.saveSettings(newSettings);
    if (engineRef.current) {
      engineRef.current.updateSettings(newSettings);
    }
    setLogs(StorageService.getLogs());
  };

  const handleToggleMaster = (val: boolean) => {
    if (engineRef.current) {
      engineRef.current.setMasterSwitch(val);
      setEngineState((prev: any) => ({ ...prev, masterSwitch: val }));
      StorageService.addLog({ 
        module: 'System', 
        type: 'system', 
        message: `策略总开关已${val ? '开启' : '关闭'}` 
      });
      setLogs(StorageService.getLogs());
    }
  };

  const handleClearLogs = () => {
    StorageService.clearLogs();
    setLogs([]);
  };

  const refreshIp = async () => {
    setIp('正在刷新...');
    try {
      const binance = new BinanceService(settings.binance.apiKey, settings.binance.secretKey, settings.binance.baseUrl);
      const newIp = await binance.getIp();
      setIp(newIp);
    } catch (err) {
      console.error('Refresh IP failed:', err);
      setIp('获取失败');
    }
  };

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
          onForceStage0={() => engineRef.current?.forceRunStage0()}
          onForceStage0P={() => engineRef.current?.forceRunStage0P()}
          onForceStage1={() => engineRef.current?.forceRunStage1()}
          onForceStage2={() => engineRef.current?.forceRunStage2()}
        />
      )}
      {activeTab === 'logs' && <LogView logs={logs} onClear={handleClearLogs} />}
      {activeTab === 'settings' && <SettingsView settings={settings} onSave={handleSaveSettings} ip={ip} onRefreshIp={refreshIp} />}
    </Layout>
  );
}
